import type { DatabaseSync } from 'node:sqlite';

import type {
  MessageRecord,
  MessageRole,
  Platform
} from '../../core/types/domain.js';

interface UserMessageInput {
  platform: Platform;
  conversationId: number;
  platformMessageId: string;
  senderOpenId: string | null;
  contentText: string;
  contentJson: string | null;
  createdAt: string;
}

interface InsertUserMessageResult {
  id: number;
  inserted: boolean;
}

interface AssistantMessageInput {
  platform: Platform;
  conversationId: number;
  contentText: string;
  contentJson: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  model: string | null;
  responseId: string | null;
  status: string;
  createdAt: string;
}

export class MessageRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public getById(id: number): MessageRecord | null {
    const row = this.database.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? mapMessageRow(row as Record<string, unknown>) : null;
  }

  public getRecentConversationMessages(
    conversationId: number,
    limit: number
  ): MessageRecord[] {
    const rows = this.database
      .prepare(`
        SELECT *
        FROM messages
        WHERE conversation_id = ?
          AND role IN ('user', 'assistant')
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(conversationId, limit) as Array<Record<string, unknown>>;

    return rows.map(mapMessageRow).reverse();
  }

  public insertUserMessage(input: UserMessageInput): InsertUserMessageResult {
    const result = this.database
      .prepare(`
        INSERT OR IGNORE INTO messages (
          platform,
          conversation_id,
          platform_message_id,
          reply_to_message_id,
          role,
          sender_open_id,
          content_text,
          content_json,
          token_input,
          token_output,
          model,
          response_id,
          status,
          created_at
        ) VALUES (?, ?, ?, NULL, 'user', ?, ?, ?, NULL, NULL, NULL, NULL, 'received', ?)
      `)
      .run(
        input.platform,
        input.conversationId,
        input.platformMessageId,
        input.senderOpenId,
        input.contentText,
        input.contentJson,
        input.createdAt
      );

    if (Number(result.changes) > 0) {
      return {
        id: Number(result.lastInsertRowid),
        inserted: true
      };
    }

    const existing = this.database
      .prepare(
        'SELECT id FROM messages WHERE platform = ? AND platform_message_id = ?'
      )
      .get(input.platform, input.platformMessageId) as { id: number } | undefined;
    if (!existing) {
      throw new Error('Failed to insert user message.');
    }

    return {
      id: Number(existing.id),
      inserted: false
    };
  }

  public insertAssistantMessage(input: AssistantMessageInput): number {
    const result = this.database
      .prepare(`
        INSERT INTO messages (
          platform,
          conversation_id,
          platform_message_id,
          reply_to_message_id,
          role,
          sender_open_id,
          content_text,
          content_json,
          token_input,
          token_output,
          model,
          response_id,
          status,
          created_at
        ) VALUES (?, ?, NULL, NULL, 'assistant', NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.platform,
        input.conversationId,
        input.contentText,
        input.contentJson,
        input.tokenInput,
        input.tokenOutput,
        input.model,
        input.responseId,
        input.status,
        input.createdAt
      );

    return Number(result.lastInsertRowid);
  }

  public markAssistantMessageSent(
    messageId: number,
    platformMessageId: string | null
  ): void {
    this.database
      .prepare(`
        UPDATE messages
        SET platform_message_id = COALESCE(?, platform_message_id),
            status = 'sent'
        WHERE id = ?
      `)
      .run(platformMessageId, messageId);
  }

  public updateStatus(messageId: number, status: string): void {
    this.database
      .prepare(`
        UPDATE messages
        SET status = ?
        WHERE id = ?
      `)
      .run(status, messageId);
  }
}

function mapMessageRow(row: Record<string, unknown>): MessageRecord {
  return {
    id: Number(row.id),
    platform: row.platform as Platform,
    conversationId: Number(row.conversation_id),
    platformMessageId:
      row.platform_message_id === null || row.platform_message_id === undefined
        ? null
        : String(row.platform_message_id),
    replyToMessageId:
      row.reply_to_message_id === null || row.reply_to_message_id === undefined
        ? null
        : String(row.reply_to_message_id),
    role: row.role as MessageRole,
    senderOpenId:
      row.sender_open_id === null || row.sender_open_id === undefined
        ? null
        : String(row.sender_open_id),
    contentText: String(row.content_text),
    contentJson:
      row.content_json === null || row.content_json === undefined
        ? null
        : String(row.content_json),
    tokenInput:
      row.token_input === null || row.token_input === undefined
        ? null
        : Number(row.token_input),
    tokenOutput:
      row.token_output === null || row.token_output === undefined
        ? null
        : Number(row.token_output),
    model:
      row.model === null || row.model === undefined ? null : String(row.model),
    responseId:
      row.response_id === null || row.response_id === undefined
        ? null
        : String(row.response_id),
    status: String(row.status),
    createdAt: String(row.created_at)
  };
}
