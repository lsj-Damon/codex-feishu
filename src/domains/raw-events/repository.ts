import type { DatabaseSync } from 'node:sqlite';

import type { NormalizedInboundMessage } from '../../core/types/domain.js';

export class RawEventRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public insertIfNew(message: NormalizedInboundMessage): boolean {
    const result = this.database
      .prepare(`
        INSERT OR IGNORE INTO raw_events (
          platform,
          event_id,
          event_type,
          message_id,
          chat_id,
          sender_open_id,
          payload_json,
          received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.platform,
        message.eventId,
        message.eventType,
        message.platformMessageId,
        message.chatId,
        message.senderOpenId,
        message.rawPayloadJson,
        message.receivedAt
      );

    return Number(result.changes) > 0;
  }
}

