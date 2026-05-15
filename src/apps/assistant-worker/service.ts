import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { AppConfig } from '../../core/config/index.js';
import { executeInTransaction } from '../../core/db/database.js';
import { classifyFailure, computeRetryDelayMs } from '../../core/errors/retry-policy.js';
import { HealthReporter } from '../../core/health/reporter.js';
import type { AppLogger } from '../../core/logger/logger.js';
import type { DeliveryRecord, JobRecord } from '../../core/types/domain.js';
import { addMilliseconds, nowIso, sleep } from '../../core/utils/time.js';
import {
  buildDownloadedImageAttachment,
  resolveImageAttachmentPath
} from '../../domains/attachments/image-cache.js';
import { MessageAttachmentRepository } from '../../domains/attachments/repository.js';
import { ConversationRepository } from '../../domains/conversation/repository.js';
import { generateConversationSummary } from '../../domains/conversation/summary.js';
import { RealCodexCliClient } from '../../domains/codex/client.js';
import {
  createWorkspaceProject,
  listWorkspaceProjects,
  parseCodexControlCommand,
  resolveWorkspaceProject
} from '../../domains/codex/control-commands.js';
import { consumeCodexRunStream } from '../../domains/codex/stream-publisher.js';
import type {
  CodexCliClient,
  CodexRunCompletion
} from '../../domains/codex/types.js';
import { CodexSessionManager } from '../../domains/codex/session-manager.js';
import { DeliveryRepository } from '../../domains/deliveries/repository.js';
import { FeishuMessageClient } from '../../domains/feishu/client.js';
import { JobAttemptRepository } from '../../domains/jobs/attempt-repository.js';
import { JobRepository } from '../../domains/jobs/repository.js';
import { MessageRepository } from '../../domains/messages/repository.js';
import { buildConversationContext } from '../../domains/openai/context-builder.js';

export class AssistantWorkerService {
  private readonly workerId = `worker-${randomUUID()}`;
  private readonly conversations: ConversationRepository;
  private readonly deliveries: DeliveryRepository;
  private readonly jobAttempts: JobAttemptRepository;
  private readonly attachments: MessageAttachmentRepository;
  private readonly messages: MessageRepository;
  private readonly jobs: JobRepository;
  private readonly codexSessionManager: CodexSessionManager;
  private readonly codexClient: CodexCliClient;
  private running = false;
  private readonly state = {
    lastHeartbeatAt: null as string | null,
    lastSuccessAt: null as string | null,
    lastErrorAt: null as string | null,
    lastRetryAt: null as string | null,
    recoveredJobs: 0,
    processedJobs: 0,
    retryScheduled: 0
  };

  public constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseSync,
    private readonly logger: AppLogger,
    private readonly feishuClient: FeishuMessageClient,
    private readonly _openAiClient: unknown,
    private readonly healthReporter: HealthReporter,
    codexClient?: CodexCliClient
  ) {
    this.conversations = new ConversationRepository(database);
    this.deliveries = new DeliveryRepository(database);
    this.jobAttempts = new JobAttemptRepository(database);
    this.attachments = new MessageAttachmentRepository(database);
    this.messages = new MessageRepository(database);
    this.jobs = new JobRepository(database);
    this.codexSessionManager = new CodexSessionManager(database);
    this.codexClient =
      codexClient ?? new RealCodexCliClient(this.config.codex.cliPath);
  }

  public async start(): Promise<void> {
    this.running = true;
    this.writeHealth('starting');
    this.logger.info('worker loop started', {
      worker_id: this.workerId,
      poll_interval_ms: this.config.worker.pollIntervalMs
    });

    while (this.running) {
      const processed = await this.runSingleIteration();
      await sleep(processed ? 25 : this.config.worker.pollIntervalMs);
    }
  }

  public stop(): void {
    this.running = false;
  }

  public async runSingleIteration(): Promise<boolean> {
    const now = nowIso();
    this.state.lastHeartbeatAt = now;

    const recovered = this.jobs.recoverExpiredRunningJobs(now);
    if (recovered.requeued > 0 || recovered.failed > 0) {
      this.state.recoveredJobs += recovered.requeued + recovered.failed;
      this.logger.warn('recovered expired running jobs', {
        worker_id: this.workerId,
        requeued: recovered.requeued,
        failed: recovered.failed
      });
    }

    const job = this.jobs.leaseNextRunnableJob({
      workerId: this.workerId,
      now,
      leaseDurationMs: this.config.worker.leaseDurationMs
    });

    if (!job) {
      this.writeHealth('idle');
      return false;
    }

    return await this.processJob(job, now);
  }

  private async processJob(job: JobRecord, leasedAt: string): Promise<boolean> {
    const conversation = this.conversations.getById(job.conversationId);
    const triggerMessage = this.messages.getById(job.triggerMessageId);
    if (!conversation || !triggerMessage) {
      this.jobs.markFailed(
        job.id,
        'JOB_REFERENCES_MISSING',
        'Job references missing conversation or trigger message.',
        nowIso()
      );
      this.writeHealth('running');
      return true;
    }

    const traceId = triggerMessage.platformMessageId
      ? `feishu:${triggerMessage.platformMessageId}`
      : `job:${job.id}`;
    const jobLogger = this.logger.child({
      worker_id: this.workerId,
      job_id: job.id,
      conversation_id: job.conversationId,
      attempt: job.attemptCount,
      trace_id: traceId
    });
    jobLogger.info('leased runnable job', {
      next_lease_expiry: addMilliseconds(
        leasedAt,
        this.config.worker.leaseDurationMs
      )
    });

    const attemptId = this.jobAttempts.startAttempt({
      jobId: job.id,
      attemptNo: job.attemptCount,
      workerId: this.workerId,
      startedAt: leasedAt
    });
    const stopLeaseRenewal = this.startLeaseRenewal(job.id, jobLogger);
    let stage: 'generation' | 'delivery' = 'generation';
    let codexCompletion: CodexRunCompletion | null = null;
    let deliveryStatus: string | null = null;
    let currentSessionId: number | null = null;

    try {
      const command = parseCodexControlCommand(triggerMessage.contentText);
      const controlResult = this.tryHandleControlCommand(
        conversation,
        command
      );
      if (controlResult) {
        await this.sendLocalReply({
          conversationId: conversation.id,
          chatId: conversation.chatId,
          replyToMessageId: triggerMessage.platformMessageId,
          jobId: job.id,
          replyText: controlResult.replyText,
          metadata: {
            source: 'local_control_command',
            command: controlResult.commandType
          }
        }, jobLogger);

        this.state.processedJobs += 1;
        this.state.lastSuccessAt = nowIso();
        this.jobAttempts.finishAttempt({
          attemptId,
          outcome: 'succeeded',
          finishedAt: nowIso(),
          feishuSendStatus: 'sent'
        });
        jobLogger.info('control command handled locally', {
          command_type: controlResult.commandType
        });
        this.writeHealth('running');
        return true;
      }

      const existingDelivery = this.deliveries.getByJobId(job.id);
      if (existingDelivery) {
        stage = 'delivery';
        await this.sendExistingDelivery(
          existingDelivery,
          conversation.chatId,
          triggerMessage.platformMessageId,
          conversation.id,
          job.id,
          jobLogger,
          {}
        );
      } else {
        const projectBinding =
          this.ensureConversationProjectBinding(conversation);
        const effectiveUserText = this.resolveCodexUserText(
          command,
          triggerMessage.contentText
        );
        const execution = await this.executeCodexJob({
          conversationId: conversation.id,
          chatId: conversation.chatId,
          replyToMessageId: triggerMessage.platformMessageId,
          jobId: job.id,
          userMessageId: triggerMessage.id,
          projectName: projectBinding.projectName,
          projectPath: projectBinding.projectPath,
          latestUserText: effectiveUserText,
          logger: jobLogger
        });
        currentSessionId = execution.sessionId;
        codexCompletion = execution.completion;

        await this.sendLocalReply({
          conversationId: conversation.id,
          chatId: conversation.chatId,
          replyToMessageId: triggerMessage.platformMessageId,
          jobId: job.id,
          replyText:
            codexCompletion.finalMessageText ??
            'Codex execution completed.',
          metadata: {
            source: 'codex',
            sessionId: execution.sessionId,
            codexSessionId: codexCompletion.codexSessionId,
            projectName: projectBinding.projectName,
            runId: execution.runId,
            jobRunSummary: this.codexSessionManager.getRunSummaryByJobId(job.id)
          }
        }, jobLogger);
      }

      this.refreshConversationSummary(conversation.id);

      this.state.processedJobs += 1;
      this.state.lastSuccessAt = nowIso();
      this.jobAttempts.finishAttempt({
        attemptId,
        outcome: 'succeeded',
        finishedAt: nowIso(),
        openaiRequestId: codexCompletion?.codexSessionId ?? null,
        feishuSendStatus: 'sent'
      });
      jobLogger.info('job completed');
      this.writeHealth('running');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (currentSessionId && (stage === 'generation' || message.toLowerCase().includes('resume'))) {
        this.codexSessionManager.markSessionBroken(currentSessionId);
      }

      const classification = classifyFailure(error, stage);
      const now = nowIso();
      const retryable = classification.retryable && job.attemptCount < job.maxAttempts;
      const delivery = this.deliveries.getByJobId(job.id);

      if (retryable) {
        const delayMs = computeRetryDelayMs(
          job.attemptCount,
          this.config.worker.retryBaseMs,
          this.config.worker.retryMaxDelayMs
        );
        const availableAt = addMilliseconds(now, delayMs);

        if (delivery) {
          this.deliveries.markRetry(delivery.id, classification.message, now);
          this.messages.updateStatus(
            delivery.assistantMessageId,
            'delivery_retry_wait'
          );
          deliveryStatus = 'retry_wait';
        }

        this.jobs.scheduleRetry(
          job.id,
          classification.code,
          classification.message,
          availableAt,
          now
        );
        this.state.retryScheduled += 1;
        this.state.lastRetryAt = now;
        this.jobAttempts.finishAttempt({
          attemptId,
          outcome: 'retry_scheduled',
          finishedAt: now,
          errorCode: classification.code,
          errorMessage: classification.message,
          openaiRequestId: codexCompletion?.codexSessionId ?? null,
          feishuSendStatus: deliveryStatus
        });
        jobLogger.warn('job scheduled for retry', {
          error_code: classification.code,
          error_message: classification.message,
          next_available_at: availableAt
        });
      } else {
        if (delivery) {
          this.deliveries.markFailed(delivery.id, classification.message, now);
          this.messages.updateStatus(
            delivery.assistantMessageId,
            'delivery_failed'
          );
          deliveryStatus = 'failed';
        }

        this.jobs.markFailed(
          job.id,
          classification.code,
          classification.message,
          now
        );
        if (codexCompletion === null && currentSessionId) {
          const summary = this.codexSessionManager.getRunSummaryByJobId(job.id);
          const runToComplete =
            summary.activeRun ?? summary.latestAttemptRun;
          if (runToComplete) {
            this.codexSessionManager.completeRun(runToComplete.id, {
              status: 'failed',
              exitCode: null,
              jsonlPath: null,
              stderrPath: null,
              finalReplyText: classification.message
            });
          }
          this.codexSessionManager.markSessionIdle(currentSessionId);
        }
        this.state.lastErrorAt = now;
        this.jobAttempts.finishAttempt({
          attemptId,
          outcome: 'failed',
          finishedAt: now,
          errorCode: classification.code,
          errorMessage: classification.message,
          openaiRequestId: codexCompletion?.codexSessionId ?? null,
          feishuSendStatus: deliveryStatus
        });
        jobLogger.error('job failed', {
          error_code: classification.code,
          error_message: classification.message
        });
      }

      this.writeHealth('running');
      return true;
    } finally {
      if (currentSessionId && codexCompletion && codexCompletion.exitCode === 0) {
        this.codexSessionManager.markSessionActive(currentSessionId);
      }
      stopLeaseRenewal();
    }
  }

  private buildCodexPrompt(
    projectName: string,
    conversationId: number,
    latestUserText: string,
    options?: {
      hasImageAttachment?: boolean;
      imageAttachmentReady?: boolean;
      imagePreparationWarning?: string | null;
    }
  ): string {
    const recentMessages = this.buildPromptTranscriptMessages(
      conversationId,
      {
        hasImageAttachment: options?.hasImageAttachment ?? false,
        imageAttachmentReady: options?.imageAttachmentReady ?? false
      }
    );
    const transcript = recentMessages
      .slice(-6)
      .map((message) => `${message.role}: ${message.contentText}`)
      .join('\n');

    const imageContext: string[] = [];
    if (options?.hasImageAttachment) {
      if (options?.imageAttachmentReady) {
        imageContext.push(
          'The current user message includes a screenshot attachment from Feishu, and the screenshot has already been downloaded successfully and attached to this turn.'
        );
        imageContext.push(
          'Treat the screenshot as available input for this turn. Do not say that the screenshot is missing unless the current turn explicitly says attachment download failed.'
        );
      } else {
        imageContext.push(
          'The current user message includes a screenshot attachment from Feishu. Inspect the screenshot together with the repository state and the ongoing session context.'
        );
      }
      if (latestUserText.trim() === '[feishu:image]') {
        imageContext.push(
          'The screenshot may show runtime output, an error state, or a UI result after a code change. Analyze what the screenshot shows and propose or apply the next code fix.'
        );
      }
    }
    if (options?.imagePreparationWarning) {
      imageContext.push(
        `Screenshot attachment warning: ${options.imagePreparationWarning}`
      );
    }

    return [
      `You are handling a Feishu conversation for project ${projectName}.`,
      `Working directory is constrained to the selected project under ${this.config.codex.workspaceRoot}.`,
      `Prefer concise, high-signal replies suitable for instant messaging.`,
      ...(imageContext.length > 0
        ? [imageContext.join('\n')]
        : []),
      `Recent conversation context:`,
      transcript || '(none)',
      `Current user request:`,
      latestUserText
    ].join('\n\n');
  }

  private buildPromptTranscriptMessages(
    conversationId: number,
    options: {
      hasImageAttachment: boolean;
      imageAttachmentReady: boolean;
    }
  ) {
    const recentMessages = this.messages.getRecentConversationMessages(
      conversationId,
      Math.max(this.config.worker.maxContextMessages, 6)
    );

    if (!options.hasImageAttachment || !options.imageAttachmentReady) {
      return recentMessages;
    }

    return recentMessages.filter((message) => {
      if (message.role !== 'assistant') {
        return true;
      }

      return !isHistoricalImageFailureReply(message.contentText);
    });
  }

  private ensureConversationProjectBinding(conversation: {
    id: number;
    currentProjectName: string | null;
    currentProjectPath: string | null;
  }): { projectName: string; projectPath: string } {
    if (conversation.currentProjectName && conversation.currentProjectPath) {
      return {
        projectName: conversation.currentProjectName,
        projectPath: conversation.currentProjectPath
      };
    }

    const fallbackProjectName = path.basename(process.cwd());
    const fallbackProjectPath = path.join(
      this.config.codex.workspaceRoot,
      fallbackProjectName
    );

    this.conversations.bindProject(conversation.id, {
      workspaceRoot: this.config.codex.workspaceRoot,
      projectName: fallbackProjectName,
      projectPath: fallbackProjectPath,
      activeSessionId: null,
      switchedAt: nowIso()
    });

    return {
      projectName: fallbackProjectName,
      projectPath: fallbackProjectPath
    };
  }

  private async sendLocalReply(
    input: {
      conversationId: number;
      chatId: string;
      replyToMessageId: string | null;
      jobId: number;
      replyText: string;
      metadata: Record<string, unknown>;
    },
    logger: AppLogger
  ): Promise<void> {
    const persisted = executeInTransaction(this.database, () => {
      const assistantMessageId = this.messages.insertAssistantMessage({
        platform: 'feishu',
        conversationId: input.conversationId,
        contentText: input.replyText,
        contentJson: JSON.stringify(input.metadata),
        tokenInput: null,
        tokenOutput: null,
        model: null,
        responseId: null,
        status: 'generated',
        createdAt: nowIso()
      });
      const delivery = this.deliveries.createPending({
        jobId: input.jobId,
        assistantMessageId,
        platform: 'feishu',
        deliveryType: 'message_reply',
        createdAt: nowIso()
      });
      return { delivery };
    });

    await this.sendExistingDelivery(
      persisted.delivery,
      input.chatId,
      input.replyToMessageId,
      input.conversationId,
      input.jobId,
      logger,
      { clearLastResponseId: true }
    );
  }

  private async sendExistingDelivery(
    delivery: DeliveryRecord,
    chatId: string,
    replyToMessageId: string | null,
    conversationId: number,
    jobId: number,
    logger: AppLogger,
    options: {
      clearLastResponseId?: boolean;
    }
  ): Promise<void> {
    const assistantMessage = this.messages.getById(delivery.assistantMessageId);
    if (!assistantMessage) {
      throw new Error('Delivery references missing assistant message.');
    }

    this.deliveries.beginAttempt(delivery.id, nowIso());
    const response = await this.feishuClient.replyText({
      chatId,
      replyToMessageId,
      text: assistantMessage.contentText
    });

    executeInTransaction(this.database, () => {
      this.deliveries.markSucceeded(
        delivery.id,
        response.platformMessageId,
        nowIso()
      );
      this.messages.markAssistantMessageSent(
        assistantMessage.id,
        response.platformMessageId
      );
      this.conversations.markAssistantMessage(
        conversationId,
        assistantMessage.id,
        assistantMessage.responseId,
        nowIso(),
        {
          clearLastResponseId: options.clearLastResponseId ?? true
        }
      );
      this.jobs.markSucceeded(jobId, assistantMessage.id, nowIso());
    });

    logger.info('delivery sent to feishu', {
      assistant_message_id: assistantMessage.id,
      delivery_attempt: delivery.attemptCount + 1,
      platform_message_id: response.platformMessageId
    });
  }

  private startLeaseRenewal(jobId: number, logger: AppLogger): () => void {
    const timer = setInterval(() => {
      const renewed = this.jobs.renewLease(
        jobId,
        this.workerId,
        this.config.worker.leaseDurationMs,
        nowIso()
      );
      if (renewed) {
        logger.debug('renewed job lease');
      } else {
        logger.warn('failed to renew job lease');
      }
    }, this.config.worker.leaseRenewIntervalMs);

    return () => {
      clearInterval(timer);
    };
  }

  private writeHealth(status: string): void {
    this.healthReporter.update({
      status,
      workerId: this.workerId,
      ...this.state,
      jobs: this.jobs.countByStatus()
    });
  }

  private refreshConversationSummary(conversationId: number): void {
    const conversation = this.conversations.getById(conversationId);
    if (!conversation) {
      return;
    }

    if (
      conversation.messageCount < this.config.worker.summaryTriggerMessageCount
    ) {
      return;
    }

    if (
      conversation.summaryText &&
      this.config.worker.summaryRefreshInterval > 0 &&
      conversation.messageCount % this.config.worker.summaryRefreshInterval !== 0
    ) {
      return;
    }

    const messages = this.messages.getRecentConversationMessages(
      conversationId,
      Math.max(this.config.worker.maxContextMessages * 2, 16)
    );
    const summaryText = generateConversationSummary({ messages });
    if (!summaryText?.trim()) {
      return;
    }

    this.conversations.updateSummary(
      conversationId,
      summaryText.trim(),
      nowIso()
    );
  }

  private tryHandleControlCommand(
    conversation: {
      id: number;
      currentProjectName: string | null;
      currentProjectPath: string | null;
    },
    command: ReturnType<typeof parseCodexControlCommand>
  ): { commandType: string; replyText: string } | null {
    if (command.type === 'normal_message' || command.type === 'analyze_project') {
      return null;
    }

    if (command.type === 'list_projects') {
      const projects = listWorkspaceProjects(this.config.codex.workspaceRoot);
      if (projects.length === 0) {
        return {
          commandType: command.type,
          replyText: `当前工作区为空：${this.config.codex.workspaceRoot}`
        };
      }

      const lines = projects.map((project) =>
        project.name === conversation.currentProjectName
          ? `- ${project.name} (当前项目)`
          : `- ${project.name}`
      );
      return {
        commandType: command.type,
        replyText: `项目列表：\n${lines.join('\n')}`
      };
    }

    if (command.type === 'current_project') {
      if (!conversation.currentProjectName || !conversation.currentProjectPath) {
        return {
          commandType: command.type,
          replyText: '当前未绑定项目，请先发送“切换项目 <name>”或“新建项目 <name>”。'
        };
      }

      return {
        commandType: command.type,
        replyText: `当前项目：${conversation.currentProjectName}\n路径：${conversation.currentProjectPath}`
      };
    }

    if (command.type === 'switch_project') {
      const project = resolveWorkspaceProject(
        this.config.codex.workspaceRoot,
        command.projectName
      );
      if (!project) {
        return {
          commandType: command.type,
          replyText: `切换失败：项目 ${command.projectName} 不存在，或不在允许的工作区范围内。`
        };
      }

      const session = this.codexSessionManager.ensureSessionForProject({
        conversationId: conversation.id,
        workspaceRoot: this.config.codex.workspaceRoot,
        projectName: project.name,
        projectPath: project.path
      });
      return {
        commandType: command.type,
        replyText: `已切换项目到 ${project.name}\n路径：${project.path}\n会话：${session.id}`
      };
    }

    if (command.type === 'create_project') {
      const project = createWorkspaceProject(
        this.config.codex.workspaceRoot,
        command.projectName
      );
      if (!project) {
        return {
          commandType: command.type,
          replyText: `新建失败：项目名 ${command.projectName} 非法，或超出允许工作区范围。`
        };
      }

      const session = this.codexSessionManager.ensureSessionForProject({
        conversationId: conversation.id,
        workspaceRoot: this.config.codex.workspaceRoot,
        projectName: project.name,
        projectPath: project.path
      });
      return {
        commandType: command.type,
        replyText: `已新建并切换到项目 ${project.name}\n路径：${project.path}\n会话：${session.id}`
      };
    }

    return null;
  }

  private resolveCodexUserText(
    command: ReturnType<typeof parseCodexControlCommand>,
    fallbackText: string
  ): string {
    if (command.type === 'analyze_project') {
      return '/understand --language zh';
    }

    return fallbackText;
  }

  private async executeCodexJob(input: {
    conversationId: number;
    chatId: string;
    replyToMessageId: string | null;
    jobId: number;
    userMessageId: number;
    projectName: string;
    projectPath: string;
    latestUserText: string;
    logger: AppLogger;
  }): Promise<{
    sessionId: number;
    runId: number;
    completion: CodexRunCompletion;
  }> {
    const initialSession = this.codexSessionManager.ensureSessionForProject({
      conversationId: input.conversationId,
      workspaceRoot: this.config.codex.workspaceRoot,
      projectName: input.projectName,
      projectPath: input.projectPath
    });

    try {
      return await this.executeCodexRunAttempt({
        ...input,
        session: initialSession
      });
    } catch (error) {
      if (!this.shouldReplaceBrokenSession(error, initialSession)) {
        throw error;
      }

      input.logger.warn('replacing broken codex session after resume failure', {
        session_id: initialSession.id,
        codex_session_id: initialSession.codexSessionId,
        error_message: error instanceof Error ? error.message : String(error)
      });

      const replacement = this.codexSessionManager.replaceBrokenSession({
        conversationId: input.conversationId,
        workspaceRoot: this.config.codex.workspaceRoot,
        projectName: input.projectName,
        projectPath: input.projectPath,
        brokenSessionId: initialSession.id
      });

      return await this.executeCodexRunAttempt({
        ...input,
        session: replacement
      });
    }
  }

  private async executeCodexRunAttempt(input: {
    conversationId: number;
    chatId: string;
    replyToMessageId: string | null;
    jobId: number;
    userMessageId: number;
    projectName: string;
    projectPath: string;
    latestUserText: string;
    logger: AppLogger;
    session: { id: number; codexSessionId: string | null };
  }): Promise<{
    sessionId: number;
    runId: number;
    completion: CodexRunCompletion;
  }> {
    const preparedImages = await this.prepareTriggerImages(input.userMessageId);
    const run = this.codexSessionManager.createRun({
      sessionId: input.session.id,
      jobId: input.jobId,
      userMessageId: input.userMessageId,
      promptText: this.buildCodexPrompt(
        input.projectName,
        input.conversationId,
        input.latestUserText,
        {
          hasImageAttachment: preparedImages.imagePaths.length > 0,
          imageAttachmentReady: preparedImages.imageAttachmentReady,
          imagePreparationWarning: preparedImages.warning
        }
      )
    });

    this.codexSessionManager.markSessionBusy(input.session.id);
    this.codexSessionManager.markRunRunning(run.id);

    const outputDir = path.join(
      this.config.runtimeRoot,
      'runs',
      'codex',
      `run-${run.id}`
    );
    const handle = input.session.codexSessionId
      ? await this.codexClient.resumeSession({
          workspaceRoot: input.projectPath,
          codexSessionId: input.session.codexSessionId,
          promptText: run.promptText,
          outputDir,
          timeoutMs: this.config.codex.execTimeoutMs,
          imagePaths: preparedImages.imagePaths
        })
      : await this.codexClient.runNewSession({
          workspaceRoot: input.projectPath,
          promptText: run.promptText,
          outputDir,
          timeoutMs: this.config.codex.execTimeoutMs,
          imagePaths: preparedImages.imagePaths
        });

    try {
      const completion = await runWithTimeout(
        consumeCodexRunStream({
          handle,
          runId: run.id,
          sessionManager: this.codexSessionManager,
          sink: {
            sendProgress: async (text) => {
              const response = await this.feishuClient.replyText({
                chatId: input.chatId,
                replyToMessageId: input.replyToMessageId,
                text
              });
              return response.platformMessageId;
            },
            sendFinal: async () => null
          },
          progressIntervalMs:
            this.config.codex.maxProgressMessageIntervalMs,
          onWarning: (warning) => {
            input.logger.warn(warning, {
              run_id: run.id,
              session_id: input.session.id
            });
          },
          onProgressDelivered: (info) => {
            input.logger.info('progress delivered to feishu', {
              run_id: info.runId,
              event_type: info.eventType,
              category: info.category,
              feishu_message_id: info.feishuMessageId,
              text_preview: info.text.slice(0, 120)
            });
          }
        }),
        this.config.codex.execTimeoutMs,
        async () => {
          await handle.cancel();
        }
      );

      this.codexSessionManager.setCodexSessionId(
        input.session.id,
        completion.codexSessionId
      );
      this.codexSessionManager.completeRun(run.id, {
        status: completion.exitCode === 0 ? 'succeeded' : 'failed',
        exitCode: completion.exitCode,
        jsonlPath: completion.jsonlPath,
        stderrPath: completion.stderrPath,
        finalReplyText: completion.finalMessageText
      });
      this.codexSessionManager.markSessionActive(input.session.id);

      return {
        sessionId: input.session.id,
        runId: run.id,
        completion
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.codexSessionManager.completeRun(run.id, {
        status: 'failed',
        exitCode: null,
        jsonlPath: null,
        stderrPath: null,
        finalReplyText: message
      });

      if (this.shouldReplaceBrokenSession(error, input.session)) {
        this.codexSessionManager.markSessionBroken(input.session.id);
      } else {
        this.codexSessionManager.markSessionIdle(input.session.id);
      }

      throw error;
    }
  }

  private shouldReplaceBrokenSession(
    error: unknown,
    session: { codexSessionId: string | null }
  ): boolean {
    if (!session.codexSessionId) {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    return (
      lower.includes('resume') ||
      lower.includes('thread') ||
      lower.includes('session') ||
      lower.includes('broken pipe') ||
      lower.includes('epipe')
    );
  }

  private async prepareTriggerImages(messageId: number): Promise<{
    imagePaths: string[];
    imageAttachmentReady: boolean;
    warning: string | null;
  }> {
    if (!this.config.worker.imageInputEnabled) {
      return {
        imagePaths: [],
        imageAttachmentReady: false,
        warning: null
      };
    }

    const attachments = this.attachments
      .listByMessageId(messageId)
      .filter((attachment) => attachment.attachmentKind === 'image');
    const firstAttachment = attachments[0];
    if (!firstAttachment) {
      return {
        imagePaths: [],
        imageAttachmentReady: false,
        warning: null
      };
    }

    const message = this.messages.getById(messageId);
    if (!message?.platformMessageId) {
      return {
        imagePaths: [],
        imageAttachmentReady: false,
        warning:
          'the Feishu screenshot could not be attached (missing platform message id)'
      };
    }

    const localPath = resolveImageAttachmentPath(
      this.config.paths.imageAttachmentsDir,
      firstAttachment.remoteKey
    );

    try {
      if (
        firstAttachment.status !== 'downloaded' ||
        !firstAttachment.localPath ||
        firstAttachment.localPath !== localPath
      ) {
        await this.feishuClient.downloadImage(
          message.platformMessageId,
          firstAttachment.remoteKey,
          localPath
        );
        const downloaded = buildDownloadedImageAttachment(
          firstAttachment.remoteKey,
          localPath
        );
        if (!downloaded) {
          throw new Error('downloaded file is not a supported image');
        }
        this.attachments.markDownloaded(
          firstAttachment.id,
          localPath,
          downloaded.mimeType,
          nowIso()
        );
      } else {
        const downloaded = buildDownloadedImageAttachment(
          firstAttachment.remoteKey,
          firstAttachment.localPath
        );
        if (!downloaded) {
          throw new Error('cached image is invalid or unsupported');
        }
      }

      return {
        imagePaths: [localPath],
        imageAttachmentReady: true,
        warning: null
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.attachments.markFailed(firstAttachment.id, message, nowIso());
      return {
        imagePaths: [],
        imageAttachmentReady: false,
        warning: `the Feishu screenshot could not be attached (${message})`
      };
    }
  }
}

async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(async () => {
          await onTimeout();
          reject(new Error(`Codex run timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function isHistoricalImageFailureReply(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('当前还不能直接识别图片内容') ||
    normalized.includes('截图附件没有成功传到') ||
    normalized.includes('图片还是没有传到我这边') ||
    normalized.includes('the feishu screenshot could not be attached') ||
    normalized.includes('screenshot attachment warning') ||
    normalized.includes('当前状态是 `400`') ||
    normalized.includes('附件状态仍像是 `400`') ||
    normalized.includes('文字消息通') && normalized.includes('图片附件当前不通')
  );
}
