import type { DatabaseSync } from 'node:sqlite';

import type { CodexSessionRecord, CodexSessionStatus } from '../../core/types/domain.js';

interface CreateCodexSessionInput {
  conversationId: number;
  projectName: string;
  projectPath: string;
  codexSessionId?: string | null;
  status: CodexSessionStatus;
  createdAt: string;
}

export class CodexSessionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(input: CreateCodexSessionInput): CodexSessionRecord {
    const result = this.database
      .prepare(`
        INSERT INTO codex_sessions (
          conversation_id,
          project_name,
          project_path,
          codex_session_id,
          status,
          created_at,
          last_active_at,
          archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        input.conversationId,
        input.projectName,
        input.projectPath,
        input.codexSessionId ?? null,
        input.status,
        input.createdAt,
        input.createdAt
      );

    return this.getById(Number(result.lastInsertRowid))!;
  }

  public getById(id: number): CodexSessionRecord | null {
    const row = this.database
      .prepare('SELECT * FROM codex_sessions WHERE id = ?')
      .get(id);
    return row ? mapCodexSessionRow(row as Record<string, unknown>) : null;
  }

  public getActiveByConversationId(conversationId: number): CodexSessionRecord | null {
    const row = this.database
      .prepare(`
        SELECT *
        FROM codex_sessions
        WHERE conversation_id = ?
          AND status = 'active'
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(conversationId);
    return row ? mapCodexSessionRow(row as Record<string, unknown>) : null;
  }

  public findByConversationAndProject(
    conversationId: number,
    projectPath: string
  ): CodexSessionRecord | null {
    const row = this.database
      .prepare(`
        SELECT *
        FROM codex_sessions
        WHERE conversation_id = ?
          AND project_path = ?
          AND status != 'archived'
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(conversationId, projectPath);
    return row ? mapCodexSessionRow(row as Record<string, unknown>) : null;
  }

  public updateStatus(id: number, status: CodexSessionStatus, updatedAt: string): void {
    this.database
      .prepare(`
        UPDATE codex_sessions
        SET status = ?,
            last_active_at = ?,
            archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END
        WHERE id = ?
      `)
      .run(status, updatedAt, status, status === 'archived' ? updatedAt : null, id);
  }

  public setCodexSessionId(id: number, codexSessionId: string | null, updatedAt: string): void {
    this.database
      .prepare(`
        UPDATE codex_sessions
        SET codex_session_id = ?,
            last_active_at = ?
        WHERE id = ?
      `)
      .run(codexSessionId, updatedAt, id);
  }

  public deactivateOtherSessions(
    conversationId: number,
    keepSessionId: number,
    updatedAt: string
  ): void {
    this.database
      .prepare(`
        UPDATE codex_sessions
        SET status = 'idle',
            last_active_at = ?
        WHERE conversation_id = ?
          AND id != ?
          AND status IN ('active', 'busy')
      `)
      .run(updatedAt, conversationId, keepSessionId);
  }
}

function mapCodexSessionRow(row: Record<string, unknown>): CodexSessionRecord {
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    projectName: String(row.project_name),
    projectPath: String(row.project_path),
    codexSessionId:
      row.codex_session_id === null || row.codex_session_id === undefined
        ? null
        : String(row.codex_session_id),
    status: row.status as CodexSessionStatus,
    createdAt: String(row.created_at),
    lastActiveAt: String(row.last_active_at),
    archivedAt:
      row.archived_at === null || row.archived_at === undefined
        ? null
        : String(row.archived_at)
  };
}
