import type { DatabaseSync } from 'node:sqlite';

import type { CodexRunRecord, CodexRunStatus } from '../../core/types/domain.js';

interface CreateCodexRunInput {
  sessionId: number;
  jobId: number;
  userMessageId: number;
  promptText: string;
  status: CodexRunStatus;
  startedAt: string;
}

export class CodexRunRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(input: CreateCodexRunInput): CodexRunRecord {
    const result = this.database
      .prepare(`
        INSERT INTO codex_runs (
          session_id,
          job_id,
          user_message_id,
          prompt_text,
          status,
          exit_code,
          jsonl_path,
          stderr_path,
          final_reply_text,
          started_at,
          finished_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)
      `)
      .run(
        input.sessionId,
        input.jobId,
        input.userMessageId,
        input.promptText,
        input.status,
        input.startedAt
      );

    return this.getById(Number(result.lastInsertRowid))!;
  }

  public getById(id: number): CodexRunRecord | null {
    const row = this.database.prepare('SELECT * FROM codex_runs WHERE id = ?').get(id);
    return row ? mapCodexRunRow(row as Record<string, unknown>) : null;
  }

  public getLatestBySessionId(sessionId: number): CodexRunRecord | null {
    const row = this.database
      .prepare(`
        SELECT *
        FROM codex_runs
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(sessionId);
    return row ? mapCodexRunRow(row as Record<string, unknown>) : null;
  }

  public updateStatus(id: number, status: CodexRunStatus, finishedAt?: string | null): void {
    this.database
      .prepare(`
        UPDATE codex_runs
        SET status = ?,
            finished_at = COALESCE(?, finished_at)
        WHERE id = ?
      `)
      .run(status, finishedAt ?? null, id);
  }

  public complete(
    id: number,
    input: {
      status: CodexRunStatus;
      exitCode: number | null;
      jsonlPath: string | null;
      stderrPath: string | null;
      finalReplyText: string | null;
      finishedAt: string;
    }
  ): void {
    this.database
      .prepare(`
        UPDATE codex_runs
        SET status = ?,
            exit_code = ?,
            jsonl_path = ?,
            stderr_path = ?,
            final_reply_text = ?,
            finished_at = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        input.exitCode,
        input.jsonlPath,
        input.stderrPath,
        input.finalReplyText,
        input.finishedAt,
        id
      );
  }
}

function mapCodexRunRow(row: Record<string, unknown>): CodexRunRecord {
  return {
    id: Number(row.id),
    sessionId: Number(row.session_id),
    jobId: Number(row.job_id),
    userMessageId: Number(row.user_message_id),
    promptText: String(row.prompt_text),
    status: row.status as CodexRunStatus,
    exitCode:
      row.exit_code === null || row.exit_code === undefined
        ? null
        : Number(row.exit_code),
    jsonlPath:
      row.jsonl_path === null || row.jsonl_path === undefined
        ? null
        : String(row.jsonl_path),
    stderrPath:
      row.stderr_path === null || row.stderr_path === undefined
        ? null
        : String(row.stderr_path),
    finalReplyText:
      row.final_reply_text === null || row.final_reply_text === undefined
        ? null
        : String(row.final_reply_text),
    startedAt: String(row.started_at),
    finishedAt:
      row.finished_at === null || row.finished_at === undefined
        ? null
        : String(row.finished_at)
  };
}
