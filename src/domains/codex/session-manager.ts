import { executeInTransaction } from '../../core/db/database.js';
import type { DatabaseSync } from 'node:sqlite';

import type {
  CodexRunRecord,
  CodexSessionRecord
} from '../../core/types/domain.js';
import { nowIso } from '../../core/utils/time.js';
import { ConversationRepository } from '../conversation/repository.js';
import { CodexRunRepository } from './run-repository.js';
import { CodexSessionRepository } from './session-repository.js';
import { CodexStreamEventRepository } from './stream-event-repository.js';

export class CodexSessionManager {
  private readonly conversations: ConversationRepository;
  private readonly sessions: CodexSessionRepository;
  private readonly runs: CodexRunRepository;
  private readonly streamEvents: CodexStreamEventRepository;

  public constructor(private readonly database: DatabaseSync) {
    this.conversations = new ConversationRepository(database);
    this.sessions = new CodexSessionRepository(database);
    this.runs = new CodexRunRepository(database);
    this.streamEvents = new CodexStreamEventRepository(database);
  }

  public ensureSessionForProject(input: {
    conversationId: number;
    workspaceRoot: string;
    projectName: string;
    projectPath: string;
  }): CodexSessionRecord {
    return executeInTransaction(this.database, () => {
      const existing = this.sessions.findByConversationAndProject(
        input.conversationId,
        input.projectPath
      );
      const timestamp = nowIso();

      if (existing) {
        this.sessions.deactivateOtherSessions(
          input.conversationId,
          existing.id,
          timestamp
        );
        this.sessions.updateStatus(existing.id, 'active', timestamp);
        this.conversations.bindProject(input.conversationId, {
          workspaceRoot: input.workspaceRoot,
          projectName: input.projectName,
          projectPath: input.projectPath,
          activeSessionId: existing.id,
          switchedAt: timestamp
        });
        return this.sessions.getById(existing.id)!;
      }

      const created = this.sessions.create({
        conversationId: input.conversationId,
        projectName: input.projectName,
        projectPath: input.projectPath,
        status: 'active',
        createdAt: timestamp
      });
      this.sessions.deactivateOtherSessions(
        input.conversationId,
        created.id,
        timestamp
      );
      this.conversations.bindProject(input.conversationId, {
        workspaceRoot: input.workspaceRoot,
        projectName: input.projectName,
        projectPath: input.projectPath,
        activeSessionId: created.id,
        switchedAt: timestamp
      });
      return created;
    });
  }

  public getActiveSession(conversationId: number): CodexSessionRecord | null {
    return this.sessions.getActiveByConversationId(conversationId);
  }

  public getSessionById(sessionId: number): CodexSessionRecord | null {
    return this.sessions.getById(sessionId);
  }

  public markSessionBusy(sessionId: number): void {
    this.sessions.updateStatus(sessionId, 'busy', nowIso());
  }

  public markSessionActive(sessionId: number): void {
    this.sessions.updateStatus(sessionId, 'active', nowIso());
  }

  public markSessionBroken(sessionId: number): void {
    this.sessions.updateStatus(sessionId, 'broken', nowIso());
  }

  public markSessionIdle(sessionId: number): void {
    this.sessions.updateStatus(sessionId, 'idle', nowIso());
  }

  public setCodexSessionId(sessionId: number, codexSessionId: string | null): void {
    this.sessions.setCodexSessionId(sessionId, codexSessionId, nowIso());
  }

  public createRun(input: {
    sessionId: number;
    jobId: number;
    userMessageId: number;
    promptText: string;
  }): CodexRunRecord {
    return this.runs.create({
      sessionId: input.sessionId,
      jobId: input.jobId,
      userMessageId: input.userMessageId,
      promptText: input.promptText,
      status: 'queued',
      startedAt: nowIso()
    });
  }

  public markRunRunning(runId: number): void {
    this.runs.updateStatus(runId, 'running');
  }

  public completeRun(
    runId: number,
    input: {
      status: CodexRunRecord['status'];
      exitCode: number | null;
      jsonlPath: string | null;
      stderrPath: string | null;
      finalReplyText: string | null;
    }
  ): void {
    this.runs.complete(runId, {
      ...input,
      finishedAt: nowIso()
    });
  }

  public appendStreamEvent(input: {
    runId: number;
    sequenceNo: number;
    eventType: string;
    payloadJson: string;
  }) {
    return this.streamEvents.append({
      ...input,
      createdAt: nowIso()
    });
  }

  public markStreamEventPushed(id: number, feishuMessageId: string | null): void {
    this.streamEvents.markPushedToFeishu(id, feishuMessageId);
  }

  public listRunEvents(runId: number) {
    return this.streamEvents.listByRunId(runId);
  }
}
