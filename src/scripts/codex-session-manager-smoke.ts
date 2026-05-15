import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { CodexSessionManager } from '../domains/codex/session-manager.js';
import type { AppConfig } from '../core/config/index.js';
import { ensureRuntimeDirectories } from '../core/config/index.js';
import { openDatabase } from '../core/db/database.js';
import { runMigrations } from '../core/db/migrations.js';
import { AppLogger } from '../core/logger/logger.js';

async function main(): Promise<void> {
  const runtimeRoot = path.join(process.cwd(), '.runtime', 'codex-session-manager-smoke');
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });

  const config = createTestConfig(runtimeRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger('codex-session-manager-smoke', path.join(config.paths.logsDir, 'worker.log'));
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(database);
  const manager = new CodexSessionManager(database);

  const sessionA = manager.ensureSessionForProject({
    conversationId,
    workspaceRoot: config.codex.workspaceRoot,
    projectName: 'alpha',
    projectPath: path.join(config.codex.workspaceRoot, 'alpha')
  });
  assert.equal(sessionA.projectName, 'alpha');
  assert.equal(sessionA.status, 'active');

  manager.markSessionBusy(sessionA.id);
  const busySession = database.prepare(`
    SELECT status
    FROM codex_sessions
    WHERE id = ?
  `).get(sessionA.id) as { status: string };
  assert.equal(busySession.status, 'busy');

  manager.setCodexSessionId(sessionA.id, 'thread-a');
  manager.markSessionActive(sessionA.id);
  const restoredSession = manager.getActiveSession(conversationId);
  assert.equal(restoredSession?.codexSessionId, 'thread-a');
  assert.equal(restoredSession?.status, 'active');

  const sessionB = manager.ensureSessionForProject({
    conversationId,
    workspaceRoot: config.codex.workspaceRoot,
    projectName: 'beta',
    projectPath: path.join(config.codex.workspaceRoot, 'beta')
  });
  assert.equal(sessionB.projectName, 'beta');
  assert.equal(sessionB.status, 'active');

  const previousSession = database.prepare(`
    SELECT status
    FROM codex_sessions
    WHERE id = ?
  `).get(sessionA.id) as { status: string };
  assert.equal(previousSession.status, 'idle');

  manager.markSessionBroken(sessionB.id);
  const replacement = manager.ensureSessionForProject({
    conversationId,
    workspaceRoot: config.codex.workspaceRoot,
    projectName: 'beta',
    projectPath: path.join(config.codex.workspaceRoot, 'beta')
  });
  assert.notEqual(replacement.id, sessionB.id);
  assert.equal(replacement.status, 'active');

  const run = manager.createRun({
    sessionId: replacement.id,
    jobId: seedJob(database, conversationId),
    userMessageId: seedUserMessage(database, conversationId),
    promptText: 'check current project'
  });
  manager.markRunRunning(run.id);
  const event = manager.appendStreamEvent({
    runId: run.id,
    sequenceNo: 1,
    eventType: 'run_started',
    payloadJson: JSON.stringify({ ok: true })
  });
  manager.markStreamEventPushed(event.id, 'msg-progress-1');
  manager.completeRun(run.id, {
    status: 'succeeded',
    exitCode: 0,
    jsonlPath: 'run.jsonl',
    stderrPath: 'run.stderr',
    finalReplyText: 'done'
  });

  const storedRun = database.prepare(`
    SELECT status, final_reply_text
    FROM codex_runs
    WHERE id = ?
  `).get(run.id) as { status: string; final_reply_text: string };
  assert.equal(storedRun.status, 'succeeded');
  assert.equal(storedRun.final_reply_text, 'done');

  const storedEvent = database.prepare(`
    SELECT pushed_to_feishu, feishu_message_id
    FROM codex_stream_events
    WHERE id = ?
  `).get(event.id) as { pushed_to_feishu: number; feishu_message_id: string };
  assert.equal(storedEvent.pushed_to_feishu, 1);
  assert.equal(storedEvent.feishu_message_id, 'msg-progress-1');

  database.close();
  console.log('Codex session-manager smoke checks passed.');
}

function seedConversation(database: ReturnType<typeof openDatabase>): number {
  const now = nowIso();
  database.prepare(`
    INSERT INTO conversations (
      platform, conversation_key, chat_id, chat_type, user_open_id, status,
      workspace_root, active_backend, message_count, last_activity_at, created_at, updated_at
    ) VALUES ('feishu', 'chat-session', 'chat-session', 'p2p', 'user-1', 'active', ?, 'codex', 0, ?, ?, ?)
  `).run('D:\\Develop\\workspace', now, now, now);

  return Number(
    (database.prepare(`SELECT id FROM conversations WHERE conversation_key = 'chat-session'`).get() as { id: number }).id
  );
}

function seedUserMessage(database: ReturnType<typeof openDatabase>, conversationId: number): number {
  const now = nowIso();
  database.prepare(`
    INSERT INTO messages (
      platform, conversation_id, platform_message_id, reply_to_message_id,
      role, sender_open_id, content_text, content_json, token_input, token_output,
      model, response_id, status, created_at
    ) VALUES ('feishu', ?, ?, NULL, 'user', 'user-1', 'hello', '{}', NULL, NULL, NULL, NULL, 'received', ?)
  `).run(conversationId, `msg-${Date.now()}`, now);

  return Number(
    (database.prepare(`SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`).get(conversationId) as { id: number }).id
  );
}

function seedJob(database: ReturnType<typeof openDatabase>, conversationId: number): number {
  const messageId = seedUserMessage(database, conversationId);
  const now = nowIso();
  database.prepare(`
    INSERT INTO jobs (
      job_type, conversation_id, trigger_message_id, status, priority,
      attempt_count, max_attempts, available_at, locked_by, lease_expires_at,
      last_error_code, last_error_message, result_message_id, created_at, updated_at
    ) VALUES ('reply_generation', ?, ?, 'queued', 0, 0, 4, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `).run(conversationId, messageId, now, now, now);

  return Number(
    (database.prepare(`SELECT id FROM jobs WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`).get(conversationId) as { id: number }).id
  );
}

function createTestConfig(runtimeRoot: string): AppConfig {
  return {
    role: 'worker',
    workspaceRoot: process.cwd(),
    runtimeRoot,
    configFiles: {
      defaultFile: path.join(process.cwd(), 'config', 'default.json'),
      localFile: path.join(runtimeRoot, 'config', 'local.json')
    },
    paths: {
      configDir: path.join(runtimeRoot, 'config'),
      dataDir: path.join(runtimeRoot, 'data'),
      dbFile: path.join(runtimeRoot, 'data', 'app.db'),
      attachmentsDir: path.join(runtimeRoot, 'data', 'attachments'),
      imageAttachmentsDir: path.join(runtimeRoot, 'data', 'attachments', 'images'),
      backupsDir: path.join(runtimeRoot, 'backups'),
      logsDir: path.join(runtimeRoot, 'logs'),
      logFile: path.join(runtimeRoot, 'logs', 'worker.log'),
      runDir: path.join(runtimeRoot, 'run'),
      healthFile: path.join(runtimeRoot, 'run', 'worker.health.json')
    },
    feishu: {
      appId: 'cli_test',
      appSecret: 'secret_test',
      botOpenId: 'bot_open_id',
      connectionMode: 'websocket',
      domain: 'feishu',
      bindHost: '127.0.0.1',
      bindPort: 39876,
      callbackPath: '/feishu/events'
    },
    triggerPolicy: {
      allowGroups: true,
      allowedChatIds: [],
      allowedUserIds: []
    },
    openai: {
      apiKey: 'sk-test',
      model: 'gpt-5.4-mini'
    },
    codex: {
      workspaceRoot: 'D:\\Develop\\workspace',
      cliPath: 'codex',
      execTimeoutMs: 600000,
      maxProgressMessageIntervalMs: 3000,
      maxOutputChars: 4000
    },
    worker: {
      pollIntervalMs: 1,
      leaseDurationMs: 1000,
      leaseRenewIntervalMs: 10000,
      maxContextMessages: 10,
      maxMessageChars: 1800,
      maxReplyChars: 900,
      summaryTriggerMessageCount: 8,
      summaryRefreshInterval: 4,
      maxAttempts: 4,
      retryBaseMs: 0,
      retryMaxDelayMs: 0,
      imageInputEnabled: true
    },
    maintenance: {
      backupKeepCount: 5,
      rawEventRetentionDays: 7,
      deliveryRetentionDays: 14,
      jobRetentionDays: 30,
      logRetentionDays: 14
    }
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
