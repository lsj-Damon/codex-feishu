import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { AssistantWorkerService } from '../apps/assistant-worker/service.js';
import type { AppConfig } from '../core/config/index.js';
import { ensureRuntimeDirectories } from '../core/config/index.js';
import { openDatabase } from '../core/db/database.js';
import { runMigrations } from '../core/db/migrations.js';
import { HealthReporter } from '../core/health/reporter.js';
import { AppLogger } from '../core/logger/logger.js';

async function main(): Promise<void> {
  const runtimeRoot = path.join(process.cwd(), '.runtime', 'codex-control-smoke');
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });

  await testProjectCommands(runtimeRoot);
  console.log('Codex control-command smoke checks passed.');
}

async function testProjectCommands(runtimeRoot: string): Promise<void> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace');
  mkdirSync(path.join(workspaceRoot, 'alpha'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'beta'), { recursive: true });

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger('codex-control-smoke', path.join(config.paths.logsDir, 'worker.log'));
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(database, workspaceRoot);

  const listResult = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-list',
    text: '项目列表'
  });
  assert.match(listResult.replyText, /alpha/);
  assert.match(listResult.replyText, /beta/);

  const currentBefore = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-current-before',
    text: '当前项目'
  });
  assert.match(currentBefore.replyText, /当前未绑定项目/);

  const switchResult = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-switch',
    text: '切换项目 alpha'
  });
  assert.match(switchResult.replyText, /已切换项目到 alpha/);

  const currentAfter = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-current-after',
    text: '当前项目'
  });
  assert.match(currentAfter.replyText, /当前项目：alpha/);

  const createResult = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-create',
    text: '新建项目 gamma'
  });
  assert.match(createResult.replyText, /已新建并切换到项目 gamma/);

  const updatedConversation = database.prepare(`
    SELECT current_project_name, current_project_path
    FROM conversations
    WHERE id = ?
  `).get(conversationId) as {
    current_project_name: string | null;
    current_project_path: string | null;
  };
  assert.equal(updatedConversation.current_project_name, 'gamma');
  assert.equal(
    updatedConversation.current_project_path,
    path.join(workspaceRoot, 'gamma')
  );

  database.close();
}

async function runWorkerForMessage(input: {
  database: ReturnType<typeof openDatabase>;
  config: AppConfig;
  logger: AppLogger;
  conversationId: number;
  platformMessageId: string;
  text: string;
}): Promise<{ replyText: string }> {
  const createdAt = nowIso();
  input.database.prepare(`
    INSERT INTO messages (
      platform, conversation_id, platform_message_id, reply_to_message_id,
      role, sender_open_id, content_text, content_json, token_input,
      token_output, model, response_id, status, created_at
    ) VALUES ('feishu', ?, ?, NULL, 'user', 'user-1', ?, '{}', NULL, NULL, NULL, NULL, 'received', ?)
  `).run(input.conversationId, input.platformMessageId, input.text, createdAt);

  const triggerMessageId = Number(
    (input.database.prepare(`
      SELECT id FROM messages WHERE platform_message_id = ?
    `).get(input.platformMessageId) as { id: number }).id
  );

  input.database.prepare(`
    UPDATE conversations
    SET last_user_message_id = ?, message_count = message_count + 1, updated_at = ?, last_activity_at = ?
    WHERE id = ?
  `).run(triggerMessageId, createdAt, createdAt, input.conversationId);

  input.database.prepare(`
    INSERT INTO jobs (
      job_type, conversation_id, trigger_message_id, status, priority,
      attempt_count, max_attempts, available_at, locked_by, lease_expires_at,
      last_error_code, last_error_message, result_message_id, created_at, updated_at
    ) VALUES ('reply_generation', ?, ?, 'queued', 0, 0, 4, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `).run(input.conversationId, triggerMessageId, createdAt, createdAt, createdAt);

  const worker = new AssistantWorkerService(
    input.config,
    input.database,
    input.logger,
    new FakeFeishuMessageClient() as any,
    new FakeOpenAiClient() as any,
    new HealthReporter('worker', input.config.paths.healthFile)
  );
  const processed = await worker.runSingleIteration();
  assert.equal(processed, true);

  const assistantMessage = input.database.prepare(`
    SELECT content_text
    FROM messages
    WHERE conversation_id = ? AND role = 'assistant'
    ORDER BY id DESC
    LIMIT 1
  `).get(input.conversationId) as { content_text: string };

  return {
    replyText: assistantMessage.content_text
  };
}

function seedConversation(database: ReturnType<typeof openDatabase>, workspaceRoot: string): number {
  const createdAt = nowIso();
  database.prepare(`
    INSERT INTO conversations (
      platform, conversation_key, chat_id, chat_type, user_open_id, status,
      workspace_root, active_backend, message_count, last_activity_at, created_at, updated_at
    ) VALUES ('feishu', 'chat-control', 'chat-control', 'p2p', 'user-1', 'active', ?, 'codex', 0, ?, ?, ?)
  `).run(workspaceRoot, createdAt, createdAt, createdAt);

  return Number(
    (database.prepare(`SELECT id FROM conversations WHERE conversation_key = 'chat-control'`).get() as { id: number }).id
  );
}

function createTestConfig(runtimeRoot: string, workspaceRoot: string): AppConfig {
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
      workspaceRoot,
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

class FakeOpenAiClient {
  public async generateReply(): Promise<never> {
    throw new Error('OpenAI should not be called for control commands.');
  }
}

class FakeFeishuMessageClient {
  public async replyText(): Promise<{ platformMessageId: string; raw: Record<string, unknown> }> {
    return {
      platformMessageId: `reply-${Date.now()}`,
      raw: {}
    };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
