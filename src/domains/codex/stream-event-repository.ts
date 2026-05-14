import type { DatabaseSync } from 'node:sqlite';

import type { CodexStreamEventRecord } from '../../core/types/domain.js';

interface AppendCodexStreamEventInput {
  runId: number;
  sequenceNo: number;
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

export class CodexStreamEventRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public append(input: AppendCodexStreamEventInput): CodexStreamEventRecord {
    const result = this.database
      .prepare(`
        INSERT INTO codex_stream_events (
          run_id,
          sequence_no,
          event_type,
          payload_json,
          created_at,
          pushed_to_feishu,
          feishu_message_id
        ) VALUES (?, ?, ?, ?, ?, 0, NULL)
      `)
      .run(
        input.runId,
        input.sequenceNo,
        input.eventType,
        input.payloadJson,
        input.createdAt
      );

    return this.getById(Number(result.lastInsertRowid))!;
  }

  public getById(id: number): CodexStreamEventRecord | null {
    const row = this.database
      .prepare('SELECT * FROM codex_stream_events WHERE id = ?')
      .get(id);
    return row ? mapCodexStreamEventRow(row as Record<string, unknown>) : null;
  }

  public listByRunId(runId: number): CodexStreamEventRecord[] {
    const rows = this.database
      .prepare(`
        SELECT *
        FROM codex_stream_events
        WHERE run_id = ?
        ORDER BY sequence_no ASC
      `)
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map(mapCodexStreamEventRow);
  }

  public markPushedToFeishu(
    id: number,
    feishuMessageId: string | null
  ): void {
    this.database
      .prepare(`
        UPDATE codex_stream_events
        SET pushed_to_feishu = 1,
            feishu_message_id = ?
        WHERE id = ?
      `)
      .run(feishuMessageId, id);
  }
}

function mapCodexStreamEventRow(row: Record<string, unknown>): CodexStreamEventRecord {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    sequenceNo: Number(row.sequence_no),
    eventType: String(row.event_type),
    payloadJson: String(row.payload_json),
    createdAt: String(row.created_at),
    pushedToFeishu: Number(row.pushed_to_feishu ?? 0) > 0,
    feishuMessageId:
      row.feishu_message_id === null || row.feishu_message_id === undefined
        ? null
        : String(row.feishu_message_id)
  };
}
