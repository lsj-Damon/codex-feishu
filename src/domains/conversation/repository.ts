import type { DatabaseSync } from 'node:sqlite';

import type { ConversationRecord, Platform } from '../../core/types/domain.js';

interface ConversationSeed {
  platform: Platform;
  conversationKey: string;
  chatId: string;
  chatType: string;
  userOpenId: string | null;
  activityAt: string;
  workspaceRoot?: string | null;
}

export class ConversationRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public getById(id: number): ConversationRecord | null {
    const row = this.database
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id);
    return row ? mapConversationRow(row as Record<string, unknown>) : null;
  }

  public getOrCreate(seed: ConversationSeed): ConversationRecord {
    const existing = this.database
      .prepare(
        'SELECT * FROM conversations WHERE platform = ? AND conversation_key = ?'
      )
      .get(seed.platform, seed.conversationKey);

    if (existing) {
      return mapConversationRow(existing as Record<string, unknown>);
    }

    const timestamp = seed.activityAt;
    this.database
      .prepare(`
        INSERT INTO conversations (
          platform,
          conversation_key,
          chat_id,
          chat_type,
          user_open_id,
          status,
          workspace_root,
          active_backend,
          message_count,
          last_activity_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, 'codex', 0, ?, ?, ?)
      `)
      .run(
        seed.platform,
        seed.conversationKey,
        seed.chatId,
        seed.chatType,
        seed.userOpenId,
        seed.workspaceRoot ?? null,
        timestamp,
        timestamp,
        timestamp
      );

    const created = this.database
      .prepare(
        'SELECT * FROM conversations WHERE platform = ? AND conversation_key = ?'
      )
      .get(seed.platform, seed.conversationKey);

    if (!created) {
      throw new Error('Failed to create conversation.');
    }

    return mapConversationRow(created as Record<string, unknown>);
  }

  public markUserMessage(
    conversationId: number,
    messageId: number,
    activityAt: string
  ): void {
    this.database
      .prepare(`
        UPDATE conversations
        SET last_user_message_id = ?,
            message_count = message_count + 1,
            last_activity_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(messageId, activityAt, activityAt, conversationId);
  }

  public markAssistantMessage(
    conversationId: number,
    messageId: number,
    responseId: string | null,
    activityAt: string,
    options: { clearLastResponseId?: boolean } = {}
  ): void {
    this.database
      .prepare(`
        UPDATE conversations
        SET last_assistant_message_id = ?,
            last_response_id = CASE
              WHEN ? = 1 THEN NULL
              ELSE COALESCE(?, last_response_id)
            END,
            message_count = message_count + 1,
            last_activity_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        messageId,
        options.clearLastResponseId ? 1 : 0,
        responseId,
        activityAt,
        activityAt,
        conversationId
      );
  }

  public updateSummary(
    conversationId: number,
    summaryText: string,
    updatedAt: string
  ): void {
    this.database
      .prepare(`
        UPDATE conversations
        SET summary_text = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(summaryText, updatedAt, conversationId);
  }

  public bindProject(
    conversationId: number,
    input: {
      workspaceRoot: string;
      projectName: string;
      projectPath: string;
      activeSessionId: number | null;
      switchedAt: string;
    }
  ): void {
    this.database
      .prepare(`
        UPDATE conversations
        SET workspace_root = ?,
            current_project_name = ?,
            current_project_path = ?,
            active_session_id = ?,
            active_backend = 'codex',
            last_switch_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.workspaceRoot,
        input.projectName,
        input.projectPath,
        input.activeSessionId,
        input.switchedAt,
        input.switchedAt,
        conversationId
      );
  }
}

function mapConversationRow(row: Record<string, unknown>): ConversationRecord {
  return {
    id: Number(row.id),
    platform: row.platform as Platform,
    conversationKey: String(row.conversation_key),
    chatId: String(row.chat_id),
    chatType: String(row.chat_type),
    userOpenId:
      row.user_open_id === null || row.user_open_id === undefined
        ? null
        : String(row.user_open_id),
    status: String(row.status),
    lastUserMessageId:
      row.last_user_message_id === null || row.last_user_message_id === undefined
        ? null
        : Number(row.last_user_message_id),
    lastAssistantMessageId:
      row.last_assistant_message_id === null ||
      row.last_assistant_message_id === undefined
        ? null
        : Number(row.last_assistant_message_id),
    lastResponseId:
      row.last_response_id === null || row.last_response_id === undefined
        ? null
        : String(row.last_response_id),
    summaryText:
      row.summary_text === null || row.summary_text === undefined
        ? null
        : String(row.summary_text),
    workspaceRoot:
      row.workspace_root === null || row.workspace_root === undefined
        ? null
        : String(row.workspace_root),
    currentProjectName:
      row.current_project_name === null || row.current_project_name === undefined
        ? null
        : String(row.current_project_name),
    currentProjectPath:
      row.current_project_path === null || row.current_project_path === undefined
        ? null
        : String(row.current_project_path),
    activeSessionId:
      row.active_session_id === null || row.active_session_id === undefined
        ? null
        : Number(row.active_session_id),
    activeBackend:
      row.active_backend === null || row.active_backend === undefined
        ? 'codex'
        : (String(row.active_backend) as ConversationRecord['activeBackend']),
    lastSwitchAt:
      row.last_switch_at === null || row.last_switch_at === undefined
        ? null
        : String(row.last_switch_at),
    messageCount: Number(row.message_count ?? 0),
    lastActivityAt: String(row.last_activity_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
