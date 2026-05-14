import type { DatabaseSync } from 'node:sqlite';

import type { AppConfig } from '../../core/config/index.js';
import { executeInTransaction } from '../../core/db/database.js';
import { HealthReporter } from '../../core/health/reporter.js';
import type { AppLogger } from '../../core/logger/logger.js';
import type { NormalizedInboundMessage } from '../../core/types/domain.js';
import { nowIso } from '../../core/utils/time.js';
import { ConversationRepository } from '../../domains/conversation/repository.js';
import { normalizeFeishuMessageEvent } from '../../domains/feishu/event-normalizer.js';
import { FeishuLongConnection } from '../../domains/feishu/long-connection.js';
import { MessageAttachmentRepository } from '../../domains/attachments/repository.js';
import { JobRepository } from '../../domains/jobs/repository.js';
import { MessageRepository } from '../../domains/messages/repository.js';
import { RawEventRepository } from '../../domains/raw-events/repository.js';

export class BotGatewayService {
  private readonly rawEvents: RawEventRepository;
  private readonly conversations: ConversationRepository;
  private readonly attachments: MessageAttachmentRepository;
  private readonly messages: MessageRepository;
  private readonly jobs: JobRepository;
  private readonly state = {
    receivedCount: 0,
    acceptedCount: 0,
    ignoredCount: 0,
    duplicateCount: 0,
    lastEventAt: null as string | null,
    lastAcceptedAt: null as string | null,
    lastIgnoredReason: null as string | null,
    lastDuplicateAt: null as string | null
  };

  public constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseSync,
    private readonly logger: AppLogger,
    private readonly longConnection: FeishuLongConnection,
    private readonly healthReporter: HealthReporter
  ) {
    this.rawEvents = new RawEventRepository(database);
    this.conversations = new ConversationRepository(database);
    this.attachments = new MessageAttachmentRepository(database);
    this.messages = new MessageRepository(database);
    this.jobs = new JobRepository(database);
  }

  public async start(): Promise<void> {
    this.writeHealth('starting');
    await this.longConnection.start(async (payload) => {
      await this.processIncomingPayload(payload);
    });
    this.writeHealth('running');
  }

  public async stop(): Promise<void> {
    this.writeHealth('stopping');
    await this.longConnection.stop();
  }

  public async processIncomingPayload(payload: unknown): Promise<void> {
    this.state.receivedCount += 1;

    const normalized = normalizeFeishuMessageEvent(payload as any);
    if (!normalized) {
      this.state.ignoredCount += 1;
      this.state.lastIgnoredReason = 'unsupported_event';
      this.logger.debug('ignored unsupported feishu event');
      this.writeHealth('running');
      return;
    }

    this.state.lastEventAt = normalized.receivedAt;

    const triggerDecision = this.evaluateTriggerPolicy(normalized);
    if (!triggerDecision.allowed) {
      this.state.ignoredCount += 1;
      this.state.lastIgnoredReason = triggerDecision.reason ?? 'unknown';
      this.logger.info('ignored feishu event by trigger policy', {
        trace_id: normalized.eventId,
        chat_id: normalized.chatId,
        chat_type: normalized.chatType,
        sender_open_id: normalized.senderOpenId,
        reason: triggerDecision.reason
      });
      this.writeHealth('running');
      return;
    }

    const enqueueResult = executeInTransaction(this.database, () => {
      const insertedEvent = this.rawEvents.insertIfNew(normalized);
      if (!insertedEvent) {
        return null;
      }

      const conversation = this.conversations.getOrCreate({
        platform: normalized.platform,
        conversationKey: normalized.conversationKey,
        chatId: normalized.chatId,
        chatType: normalized.chatType,
        userOpenId: normalized.senderOpenId || null,
        activityAt: normalized.receivedAt
      });

      const userMessage = this.messages.insertUserMessage({
        platform: normalized.platform,
        conversationId: conversation.id,
        platformMessageId: normalized.platformMessageId,
        senderOpenId: normalized.senderOpenId || null,
        contentText: normalized.text,
        contentJson: JSON.stringify({
          messageType: normalized.messageType,
          blocks: [
            { type: 'text', text: normalized.text },
            ...normalized.attachments.map((attachment) => ({
              type: attachment.kind,
              remoteKey: attachment.remoteKey,
              attachmentIndex: attachment.attachmentIndex,
              status: 'pending'
            }))
          ]
        }),
        createdAt: normalized.receivedAt
      });

      if (!userMessage.inserted) {
        return {
          conversationId: conversation.id,
          userMessageId: userMessage.id,
          duplicateMessage: true as const,
          jobId: null
        };
      }

      this.conversations.markUserMessage(
        conversation.id,
        userMessage.id,
        normalized.receivedAt
      );

      for (const attachment of normalized.attachments) {
        this.attachments.createPending({
          messageId: userMessage.id,
          attachmentIndex: attachment.attachmentIndex,
          provider: normalized.platform,
          attachmentKind: attachment.kind,
          remoteKey: attachment.remoteKey,
          metadataJson: attachment.metadataJson ?? null,
          createdAt: normalized.receivedAt
        });
      }

      const jobId = this.jobs.enqueueReplyJob({
        conversationId: conversation.id,
        triggerMessageId: userMessage.id,
        availableAt: nowIso(),
        maxAttempts: this.config.worker.maxAttempts
      });

      return {
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        duplicateMessage: false as const,
        jobId
      };
    });

    if (!enqueueResult) {
      this.state.duplicateCount += 1;
      this.state.lastDuplicateAt = normalized.receivedAt;
      this.logger.info('duplicate feishu event ignored', {
        trace_id: normalized.eventId,
        event_id: normalized.eventId,
        platform_message_id: normalized.platformMessageId
      });
      this.writeHealth('running');
      return;
    }

    if (enqueueResult.duplicateMessage) {
      this.state.duplicateCount += 1;
      this.state.lastDuplicateAt = normalized.receivedAt;
      this.logger.info('duplicate feishu message ignored', {
        trace_id: normalized.eventId,
        conversation_id: enqueueResult.conversationId,
        platform_message_id: normalized.platformMessageId
      });
      this.writeHealth('running');
      return;
    }

    this.state.acceptedCount += 1;
    this.state.lastAcceptedAt = normalized.receivedAt;
    this.logger.info('feishu event enqueued', {
      trace_id: normalized.eventId,
      event_id: normalized.eventId,
      conversation_id: enqueueResult.conversationId,
      job_id: enqueueResult.jobId,
      text_length: normalized.text.length,
      chat_type: normalized.chatType
    });
    this.writeHealth('running');
  }

  private evaluateTriggerPolicy(
    normalized: NormalizedInboundMessage
  ): { allowed: boolean; reason?: string } {
    if (
      this.config.triggerPolicy.allowedChatIds.length > 0 &&
      !this.config.triggerPolicy.allowedChatIds.includes(normalized.chatId)
    ) {
      return {
        allowed: false,
        reason: 'chat_not_allowed'
      };
    }

    if (
      this.config.triggerPolicy.allowedUserIds.length > 0 &&
      !this.config.triggerPolicy.allowedUserIds.includes(normalized.senderOpenId)
    ) {
      return {
        allowed: false,
        reason: 'user_not_allowed'
      };
    }

    if (normalized.chatType === 'p2p') {
      return { allowed: true };
    }

    if (!this.config.triggerPolicy.allowGroups) {
      return {
        allowed: false,
        reason: 'groups_disabled'
      };
    }

    const mentionedBot = this.config.feishu.botOpenId
      ? normalized.mentionOpenIds.includes(this.config.feishu.botOpenId)
      : normalized.mentioned;
    if (!mentionedBot) {
      return {
        allowed: false,
        reason: 'group_without_bot_mention'
      };
    }

    return { allowed: true };
  }

  private writeHealth(status: string): void {
    this.healthReporter.update({
      status,
      lastHeartbeatAt: nowIso(),
      ...this.state,
      jobs: this.jobs.countByStatus()
    });
  }
}
