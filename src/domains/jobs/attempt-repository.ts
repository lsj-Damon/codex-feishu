import type { DatabaseSync } from 'node:sqlite';

import type { JobAttemptOutcome } from '../../core/types/domain.js';

interface StartJobAttemptInput {
  jobId: number;
  attemptNo: number;
  workerId: string;
  startedAt: string;
}

interface FinishJobAttemptInput {
  attemptId: number;
  outcome: JobAttemptOutcome;
  finishedAt: string;
  errorCode?: string;
  errorMessage?: string;
  openaiRequestId?: string | null;
  feishuSendStatus?: string | null;
}

export class JobAttemptRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public startAttempt(input: StartJobAttemptInput): number {
    const result = this.database
      .prepare(`
        INSERT INTO job_attempts (
          job_id,
          attempt_no,
          worker_id,
          started_at
        ) VALUES (?, ?, ?, ?)
      `)
      .run(input.jobId, input.attemptNo, input.workerId, input.startedAt);

    return Number(result.lastInsertRowid);
  }

  public finishAttempt(input: FinishJobAttemptInput): void {
    this.database
      .prepare(`
        UPDATE job_attempts
        SET finished_at = ?,
            outcome = ?,
            error_code = ?,
            error_message = ?,
            openai_request_id = ?,
            feishu_send_status = ?
        WHERE id = ?
      `)
      .run(
        input.finishedAt,
        input.outcome,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.openaiRequestId ?? null,
        input.feishuSendStatus ?? null,
        input.attemptId
      );
  }
}

