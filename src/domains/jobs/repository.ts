import type { DatabaseSync } from 'node:sqlite';

import { executeInTransaction } from '../../core/db/database.js';
import type { JobRecord } from '../../core/types/domain.js';

interface EnqueueReplyJobInput {
  conversationId: number;
  triggerMessageId: number;
  availableAt: string;
  maxAttempts: number;
}

interface LeaseJobInput {
  workerId: string;
  now: string;
  leaseDurationMs: number;
}

export class JobRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public enqueueReplyJob(input: EnqueueReplyJobInput): number {
    const timestamp = input.availableAt;
    const result = this.database
      .prepare(`
        INSERT INTO jobs (
          job_type,
          conversation_id,
          trigger_message_id,
          status,
          priority,
          attempt_count,
          max_attempts,
          available_at,
          locked_by,
          lease_expires_at,
          last_error_code,
          last_error_message,
          result_message_id,
          created_at,
          updated_at
        ) VALUES ('reply_generation', ?, ?, 'queued', 0, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `)
      .run(
        input.conversationId,
        input.triggerMessageId,
        input.maxAttempts,
        input.availableAt,
        timestamp,
        timestamp
      );

    return Number(result.lastInsertRowid);
  }

  public leaseNextRunnableJob(input: LeaseJobInput): JobRecord | null {
    return executeInTransaction(this.database, () => {
      const candidate = this.database
        .prepare(`
          SELECT id
          FROM jobs
          WHERE status IN ('queued', 'retry_wait')
            AND available_at <= ?
          ORDER BY priority DESC, id ASC
          LIMIT 1
        `)
        .get(input.now) as { id: number } | undefined;

      if (!candidate) {
        return null;
      }

      const leaseExpiresAt = new Date(
        new Date(input.now).getTime() + input.leaseDurationMs
      ).toISOString();
      const result = this.database
        .prepare(`
          UPDATE jobs
          SET status = 'running',
              locked_by = ?,
              lease_expires_at = ?,
              attempt_count = attempt_count + 1,
              updated_at = ?
          WHERE id = ?
            AND status IN ('queued', 'retry_wait')
        `)
        .run(input.workerId, leaseExpiresAt, input.now, candidate.id);

      if (Number(result.changes) === 0) {
        return null;
      }

      return this.getById(candidate.id);
    });
  }

  public getById(id: number): JobRecord | null {
    const row = this.database.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? mapJobRow(row as Record<string, unknown>) : null;
  }

  public renewLease(
    jobId: number,
    workerId: string,
    leaseDurationMs: number,
    now: string
  ): boolean {
    const leaseExpiresAt = new Date(
      new Date(now).getTime() + leaseDurationMs
    ).toISOString();
    const result = this.database
      .prepare(`
        UPDATE jobs
        SET lease_expires_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'running'
          AND locked_by = ?
      `)
      .run(leaseExpiresAt, now, jobId, workerId);

    return Number(result.changes) > 0;
  }

  public scheduleRetry(
    jobId: number,
    errorCode: string,
    errorMessage: string,
    availableAt: string,
    now: string
  ): void {
    this.database
      .prepare(`
        UPDATE jobs
        SET status = 'retry_wait',
            available_at = ?,
            last_error_code = ?,
            last_error_message = ?,
            locked_by = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      .run(availableAt, errorCode, errorMessage, now, jobId);
  }

  public recoverExpiredRunningJobs(now: string): {
    requeued: number;
    failed: number;
  } {
    return executeInTransaction(this.database, () => {
      const expired = this.database
        .prepare(`
          SELECT id, attempt_count, max_attempts
          FROM jobs
          WHERE status = 'running'
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ?
        `)
        .all(now) as Array<{
        id: number;
        attempt_count: number;
        max_attempts: number;
      }>;

      let requeued = 0;
      let failed = 0;

      for (const job of expired) {
        if (job.attempt_count < job.max_attempts) {
          this.database
            .prepare(`
              UPDATE jobs
              SET status = 'retry_wait',
                  available_at = ?,
                  locked_by = NULL,
                  lease_expires_at = NULL,
                  last_error_code = 'LEASE_EXPIRED',
                  last_error_message = 'Job lease expired before completion.',
                  updated_at = ?
              WHERE id = ?
            `)
            .run(now, now, job.id);
          requeued += 1;
        } else {
          this.database
            .prepare(`
              UPDATE jobs
              SET status = 'failed',
                  locked_by = NULL,
                  lease_expires_at = NULL,
                  last_error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
                  last_error_message = 'Job lease expired and max attempts reached.',
                  updated_at = ?
              WHERE id = ?
            `)
            .run(now, job.id);
          failed += 1;
        }
      }

      return { requeued, failed };
    });
  }

  public countByStatus(): Record<string, number> {
    const rows = this.database
      .prepare(`
        SELECT status, COUNT(*) AS count
        FROM jobs
        GROUP BY status
      `)
      .all() as Array<{ status: string; count: number }>;

    return Object.fromEntries(
      rows.map((row) => [row.status, Number(row.count)])
    );
  }

  public markSucceeded(jobId: number, resultMessageId: number, now: string): void {
    this.database
      .prepare(`
        UPDATE jobs
        SET status = 'succeeded',
            result_message_id = ?,
            locked_by = NULL,
            lease_expires_at = NULL,
            available_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(resultMessageId, now, now, jobId);
  }

  public markFailed(
    jobId: number,
    errorCode: string,
    errorMessage: string,
    now: string
  ): void {
    this.database
      .prepare(`
        UPDATE jobs
        SET status = 'failed',
            last_error_code = ?,
            last_error_message = ?,
            locked_by = NULL,
            lease_expires_at = NULL,
            available_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(errorCode, errorMessage, now, now, jobId);
  }
}


function mapJobRow(row: Record<string, unknown>): JobRecord {
  return {
    id: Number(row.id),
    jobType: row.job_type as JobRecord['jobType'],
    conversationId: Number(row.conversation_id),
    triggerMessageId: Number(row.trigger_message_id),
    status: row.status as JobRecord['status'],
    priority: Number(row.priority ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    maxAttempts: Number(row.max_attempts ?? 1),
    availableAt: String(row.available_at),
    lockedBy:
      row.locked_by === null || row.locked_by === undefined
        ? null
        : String(row.locked_by),
    leaseExpiresAt:
      row.lease_expires_at === null || row.lease_expires_at === undefined
        ? null
        : String(row.lease_expires_at),
    lastErrorCode:
      row.last_error_code === null || row.last_error_code === undefined
        ? null
        : String(row.last_error_code),
    lastErrorMessage:
      row.last_error_message === null || row.last_error_message === undefined
        ? null
        : String(row.last_error_message),
    resultMessageId:
      row.result_message_id === null || row.result_message_id === undefined
        ? null
        : Number(row.result_message_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
