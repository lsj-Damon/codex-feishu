import type { DatabaseSync } from 'node:sqlite';

import type {
  AttachmentStatus,
  MessageAttachmentRecord,
  Platform
} from '../../core/types/domain.js';

interface CreateAttachmentInput {
  messageId: number;
  attachmentIndex: number;
  provider: Platform;
  attachmentKind: 'image';
  remoteKey: string;
  metadataJson?: string | null;
  createdAt: string;
}

export class MessageAttachmentRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public createPending(input: CreateAttachmentInput): number {
    const result = this.database
      .prepare(`
        INSERT INTO message_attachments (
          message_id,
          attachment_index,
          provider,
          attachment_kind,
          remote_key,
          local_path,
          mime_type,
          status,
          width,
          height,
          metadata_json,
          last_error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, NULL, ?, NULL, ?, ?)
      `)
      .run(
        input.messageId,
        input.attachmentIndex,
        input.provider,
        input.attachmentKind,
        input.remoteKey,
        input.metadataJson ?? null,
        input.createdAt,
        input.createdAt
      );

    return Number(result.lastInsertRowid);
  }

  public listByMessageId(messageId: number): MessageAttachmentRecord[] {
    const rows = this.database
      .prepare(`
        SELECT *
        FROM message_attachments
        WHERE message_id = ?
        ORDER BY attachment_index ASC
      `)
      .all(messageId) as Array<Record<string, unknown>>;
    return rows.map(mapAttachmentRow);
  }

  public markDownloaded(
    attachmentId: number,
    localPath: string,
    mimeType: string | null,
    updatedAt: string
  ): void {
    this.database
      .prepare(`
        UPDATE message_attachments
        SET local_path = ?,
            mime_type = ?,
            status = 'downloaded',
            last_error_message = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      .run(localPath, mimeType, updatedAt, attachmentId);
  }

  public markFailed(
    attachmentId: number,
    errorMessage: string,
    updatedAt: string
  ): void {
    this.database
      .prepare(`
        UPDATE message_attachments
        SET status = 'failed',
            last_error_message = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(errorMessage, updatedAt, attachmentId);
  }
}

function mapAttachmentRow(row: Record<string, unknown>): MessageAttachmentRecord {
  return {
    id: Number(row.id),
    messageId: Number(row.message_id),
    attachmentIndex: Number(row.attachment_index),
    provider: row.provider as Platform,
    attachmentKind: row.attachment_kind as 'image',
    remoteKey: String(row.remote_key),
    localPath:
      row.local_path === null || row.local_path === undefined
        ? null
        : String(row.local_path),
    mimeType:
      row.mime_type === null || row.mime_type === undefined
        ? null
        : String(row.mime_type),
    status: row.status as AttachmentStatus,
    width:
      row.width === null || row.width === undefined ? null : Number(row.width),
    height:
      row.height === null || row.height === undefined ? null : Number(row.height),
    metadataJson:
      row.metadata_json === null || row.metadata_json === undefined
        ? null
        : String(row.metadata_json),
    lastErrorMessage:
      row.last_error_message === null || row.last_error_message === undefined
        ? null
        : String(row.last_error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
