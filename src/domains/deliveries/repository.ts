import type { DatabaseSync } from 'node:sqlite';

import type { DeliveryRecord, DeliveryStatus, Platform } from '../../core/types/domain.js';

interface CreateDeliveryInput {
  jobId: number;
  assistantMessageId: number;
  platform: Platform;
  deliveryType: string;
  createdAt: string;
}

export class DeliveryRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public getByJobId(jobId: number): DeliveryRecord | null {
    const row = this.database
      .prepare('SELECT * FROM deliveries WHERE job_id = ?')
      .get(jobId);
    return row ? mapDeliveryRow(row as Record<string, unknown>) : null;
  }

  public createPending(input: CreateDeliveryInput): DeliveryRecord {
    this.database
      .prepare(`
        INSERT INTO deliveries (
          job_id,
          assistant_message_id,
          platform,
          delivery_type,
          status,
          platform_message_id,
          attempt_count,
          last_error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, 'queued', NULL, 0, NULL, ?, ?)
      `)
      .run(
        input.jobId,
        input.assistantMessageId,
        input.platform,
        input.deliveryType,
        input.createdAt,
        input.createdAt
      );

    const created = this.getByJobId(input.jobId);
    if (!created) {
      throw new Error('Failed to create delivery record.');
    }

    return created;
  }

  public beginAttempt(deliveryId: number, now: string): void {
    this.database
      .prepare(`
        UPDATE deliveries
        SET status = 'sending',
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE id = ?
      `)
      .run(now, deliveryId);
  }

  public markRetry(deliveryId: number, errorMessage: string, now: string): void {
    this.database
      .prepare(`
        UPDATE deliveries
        SET status = 'retry_wait',
            last_error_message = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(errorMessage, now, deliveryId);
  }

  public markFailed(deliveryId: number, errorMessage: string, now: string): void {
    this.database
      .prepare(`
        UPDATE deliveries
        SET status = 'failed',
            last_error_message = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(errorMessage, now, deliveryId);
  }

  public markSucceeded(
    deliveryId: number,
    platformMessageId: string | null,
    now: string
  ): void {
    this.database
      .prepare(`
        UPDATE deliveries
        SET status = 'succeeded',
            platform_message_id = COALESCE(?, platform_message_id),
            last_error_message = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      .run(platformMessageId, now, deliveryId);
  }
}

function mapDeliveryRow(row: Record<string, unknown>): DeliveryRecord {
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    assistantMessageId: Number(row.assistant_message_id),
    platform: row.platform as Platform,
    deliveryType: String(row.delivery_type),
    status: row.status as DeliveryStatus,
    platformMessageId:
      row.platform_message_id === null || row.platform_message_id === undefined
        ? null
        : String(row.platform_message_id),
    attemptCount: Number(row.attempt_count ?? 0),
    lastErrorMessage:
      row.last_error_message === null || row.last_error_message === undefined
        ? null
        : String(row.last_error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
