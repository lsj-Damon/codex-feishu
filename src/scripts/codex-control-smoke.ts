import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { AssistantWorkerService } from '../apps/assistant-worker/service.js';
import type { AppConfig } from '../core/config/index.js';
import { ensureRuntimeDirectories } from '../core/config/index.js';
import { openDatabase } from '../core/db/database.js';
import { runMigrations } from '../core/db/migrations.js';
import { HealthReporter } from '../core/health/reporter.js';
import { AppLogger } from '../core/logger/logger.js';
import { parseCodexControlCommand } from '../domains/codex/control-commands.js';
import { FakeCodexCliClient } from '../domains/codex/fake-client.js';
import { createProgressMessageEvent } from '../domains/codex/stream-publisher.js';

async function main(): Promise<void> {
  const runtimeRoot = path.join(process.cwd(), '.runtime', 'codex-control-smoke');
  resetRuntime(runtimeRoot);

  await testProjectCommands(runtimeRoot);
  resetRuntime(runtimeRoot);
  await testWorkspaceContainerGuardrail(runtimeRoot);
  resetRuntime(runtimeRoot);
  await testCompactContextCommand(runtimeRoot);
  resetRuntime(runtimeRoot);
  await testCompactContextFallback(runtimeRoot);
  resetRuntime(runtimeRoot);
  await testCompactContextGuardrail(runtimeRoot);
  resetRuntime(runtimeRoot);
  await testStaleContainerBindingIsCleared(runtimeRoot);
  console.log('Codex control-command smoke checks passed.');
}

function resetRuntime(runtimeRoot: string): void {
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });
}

async function testProjectCommands(runtimeRoot: string): Promise<void> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace');
  mkdirSync(path.join(workspaceRoot, 'alpha'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'beta'), { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'alpha', 'package.json'), '{}');
  writeFileSync(path.join(workspaceRoot, 'beta', 'package.json'), '{}');

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'codex-control-smoke',
    path.join(config.paths.logsDir, 'worker.log')
  );
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
  assert.match(switchResult.replyText, /alpha/);

  const currentAfter = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-current-after',
    text: '当前项目'
  });
  assert.match(currentAfter.replyText, /alpha/);

  const createResult = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-create',
    text: '新建项目 gamma'
  });
  assert.match(createResult.replyText, /gamma/);

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

  assert.equal(parseCodexControlCommand('分析项目').type, 'analyze_project');
  assert.equal(parseCodexControlCommand('压缩上下文').type, 'compact_context');

  database.close();
}

async function testWorkspaceContainerGuardrail(
  runtimeRoot: string
): Promise<void> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace');
  mkdirSync(path.join(workspaceRoot, 'ecu', '.npm-cache'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'ecu', 'analysis-reports'), {
    recursive: true
  });
  mkdirSync(path.join(workspaceRoot, 'ecu', 'analysis-reports-r2'), {
    recursive: true
  });
  mkdirSync(path.join(workspaceRoot, 'ecu', 'car-gateway'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'ecu', 'car-saas'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'ecu', 'docs'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'ecu', 'ecu-firmware'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'ecu', 'mobility'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'ecu', 'services'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'ecu', 'tools'), { recursive: true });
  writeFileSync(path.join(workspaceRoot, 'ecu', 'findings.md'), '# findings');
  writeFileSync(path.join(workspaceRoot, 'ecu', 'progress.md'), '# progress');
  writeFileSync(path.join(workspaceRoot, 'ecu', 'task_plan.md'), '# plan');

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'codex-control-container-smoke',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(database, workspaceRoot);
  const result = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-switch-ecu',
    text: '切换项目 ecu'
  });

  assert.match(result.replyText, /不能切换到 ecu/);
  assert.match(result.replyText, /car-gateway/);
  assert.match(result.replyText, /car-saas|ecu-firmware|mobility|services|tools/);

  database.close();
}

async function testCompactContextCommand(runtimeRoot: string): Promise<void> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace-compact');
  const projectPath = path.join(workspaceRoot, 'alpha');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path.join(projectPath, 'package.json'), '{}');

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'codex-control-compact-smoke',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(database, workspaceRoot);
  bindActiveCompactSession(
    database,
    conversationId,
    projectPath,
    'thread-compact-test'
  );

  const fakeCodex = new FakeCodexCliClient([
    {
      sessionId: 'thread-compact-test',
      events: [
        { type: 'turn.started' },
        createProgressMessageEvent('Compacting session context'),
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Context compacted.'
          }
        }
      ],
      completion: {
        exitCode: 0,
        finalMessageText: 'Context compacted.',
        jsonlPath: path.join(runtimeRoot, 'compact.jsonl'),
        stderrPath: path.join(runtimeRoot, 'compact.stderr')
      }
    }
  ]);

  const result = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-compact',
    text: '压缩上下文',
    codexClient: fakeCodex
  });

  assert.equal(result.replyText, 'Context compacted.');
  assert.equal(fakeCodex.resumeSessionInputs.length, 1);
  assert.equal(fakeCodex.runNewSessionInputs.length, 0);
  assert.equal(fakeCodex.resumeSessionInputs[0]?.promptText, '/compact');

  database.close();
}

async function testCompactContextFallback(runtimeRoot: string): Promise<void> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace-compact-fallback');
  const projectPath = path.join(workspaceRoot, 'alpha');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path.join(projectPath, 'package.json'), '{}');

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'codex-control-compact-fallback-smoke',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(database, workspaceRoot);
  bindActiveCompactSession(
    database,
    conversationId,
    projectPath,
    'thread-compact-fallback'
  );

  const fakeCodex = new FakeCodexCliClient([
    {
      sessionId: 'thread-compact-fallback',
      events: [
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Codex execution completed.'
          }
        }
      ],
      completion: {
        exitCode: 0,
        finalMessageText: 'Codex execution completed.',
        jsonlPath: path.join(runtimeRoot, 'compact-fallback.jsonl'),
        stderrPath: path.join(runtimeRoot, 'compact-fallback.stderr')
      }
    }
  ]);

  const result = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-compact-fallback',
    text: '压缩上下文',
    codexClient: fakeCodex
  });

  assert.equal(
    result.replyText,
    '已触发上下文压缩。Codex 未返回详细摘要，但当前会话可继续使用。'
  );

  database.close();
}

async function testCompactContextGuardrail(runtimeRoot: string): Promise<void> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace-container');
  const containerPath = path.join(workspaceRoot, 'ecu');
  mkdirSync(path.join(containerPath, '.npm-cache'), { recursive: true });
  mkdirSync(path.join(containerPath, 'analysis-reports'), { recursive: true });
  mkdirSync(path.join(containerPath, 'analysis-reports-r2'), {
    recursive: true
  });
  mkdirSync(path.join(containerPath, 'car-gateway'), { recursive: true });
  mkdirSync(path.join(containerPath, 'car-saas'), { recursive: true });
  mkdirSync(path.join(containerPath, 'docs'), { recursive: true });
  mkdirSync(path.join(containerPath, 'ecu-firmware'), { recursive: true });
  mkdirSync(path.join(containerPath, 'mobility'), { recursive: true });
  mkdirSync(path.join(containerPath, 'services'), { recursive: true });
  mkdirSync(path.join(containerPath, 'tools'), { recursive: true });
  writeFileSync(path.join(containerPath, 'findings.md'), '# findings');
  writeFileSync(path.join(containerPath, 'progress.md'), '# progress');
  writeFileSync(path.join(containerPath, 'task_plan.md'), '# plan');

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'codex-control-compact-guardrail-smoke',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(database, workspaceRoot);
  bindActiveCompactSession(
    database,
    conversationId,
    containerPath,
    'thread-ecu'
  );

  const fakeCodex = new FakeCodexCliClient();
  const result = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-compact-guardrail',
    text: '压缩上下文',
    codexClient: fakeCodex
  });

  assert.match(result.replyText, /不能切换到 ecu/);
  assert.equal(fakeCodex.resumeSessionInputs.length, 0);
  assert.equal(fakeCodex.runNewSessionInputs.length, 0);

  database.close();
}

async function testStaleContainerBindingIsCleared(
  runtimeRoot: string
): Promise<void> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace-stale-container');
  const containerPath = path.join(workspaceRoot, 'ecu');
  mkdirSync(path.join(containerPath, '.npm-cache'), { recursive: true });
  mkdirSync(path.join(containerPath, 'analysis-reports'), { recursive: true });
  mkdirSync(path.join(containerPath, 'analysis-reports-r2'), {
    recursive: true
  });
  mkdirSync(path.join(containerPath, 'car-gateway'), { recursive: true });
  mkdirSync(path.join(containerPath, 'car-saas'), { recursive: true });
  mkdirSync(path.join(containerPath, 'docs'), { recursive: true });
  mkdirSync(path.join(containerPath, 'ecu-firmware'), { recursive: true });
  mkdirSync(path.join(containerPath, 'mobility'), { recursive: true });
  mkdirSync(path.join(containerPath, 'services'), { recursive: true });
  mkdirSync(path.join(containerPath, 'tools'), { recursive: true });
  writeFileSync(path.join(containerPath, 'findings.md'), '# findings');
  writeFileSync(path.join(containerPath, 'progress.md'), '# progress');
  writeFileSync(path.join(containerPath, 'task_plan.md'), '# plan');

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'codex-control-stale-container-smoke',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(database, workspaceRoot);
  bindActiveCompactSession(
    database,
    conversationId,
    containerPath,
    'thread-stale-ecu'
  );

  const fakeCodex = new FakeCodexCliClient();
  const result = await runWorkerForMessage({
    database,
    config,
    logger,
    conversationId,
    platformMessageId: 'msg-stale-container',
    text: '普通文本',
    codexClient: fakeCodex
  });

  assert.match(result.replyText, /不能切换到 ecu/);
  assert.equal(fakeCodex.resumeSessionInputs.length, 0);
  assert.equal(fakeCodex.runNewSessionInputs.length, 0);

  const binding = database.prepare(`
    SELECT current_project_name, current_project_path, active_session_id
    FROM conversations
    WHERE id = ?
  `).get(conversationId) as {
    current_project_name: string | null;
    current_project_path: string | null;
    active_session_id: number | null;
  };
  assert.equal(binding.current_project_name, null);
  assert.equal(binding.current_project_path, null);
  assert.equal(binding.active_session_id, null);

  database.close();
}

async function runWorkerForMessage(input: {
  database: ReturnType<typeof openDatabase>;
  config: AppConfig;
  logger: AppLogger;
  conversationId: number;
  platformMessageId: string;
  text: string;
  codexClient?: FakeCodexCliClient;
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
    new HealthReporter('worker', input.config.paths.healthFile),
    input.codexClient
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

function seedConversation(
  database: ReturnType<typeof openDatabase>,
  workspaceRoot: string
): number {
  const createdAt = nowIso();
  database.prepare(`
    INSERT INTO conversations (
      platform, conversation_key, chat_id, chat_type, user_open_id, status,
      workspace_root, active_backend, message_count, last_activity_at, created_at, updated_at
    ) VALUES ('feishu', 'chat-control', 'chat-control', 'p2p', 'user-1', 'active', ?, 'codex', 0, ?, ?, ?)
  `).run(workspaceRoot, createdAt, createdAt, createdAt);

  return Number(
    (
      database
        .prepare(`SELECT id FROM conversations WHERE conversation_key = 'chat-control'`)
        .get() as { id: number }
    ).id
  );
}

function bindActiveCompactSession(
  database: ReturnType<typeof openDatabase>,
  conversationId: number,
  projectPath: string,
  codexSessionId: string
): void {
  const createdAt = nowIso();
  database.prepare(`
    UPDATE conversations
    SET current_project_name = 'alpha',
        current_project_path = ?,
        active_backend = 'codex',
        last_switch_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(projectPath, createdAt, createdAt, conversationId);
  database.prepare(`
    INSERT INTO codex_sessions (
      conversation_id, project_name, project_path, codex_session_id, status,
      created_at, last_active_at, archived_at
    ) VALUES (?, 'alpha', ?, ?, 'active', ?, ?, NULL)
  `).run(conversationId, projectPath, codexSessionId, createdAt, createdAt);
  const sessionId = Number(
    (database.prepare(`
      SELECT id FROM codex_sessions WHERE conversation_id = ? ORDER BY id DESC LIMIT 1
    `).get(conversationId) as { id: number }).id
  );
  database.prepare(`
    UPDATE conversations
    SET active_session_id = ?
    WHERE id = ?
  `).run(sessionId, conversationId);
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
      imageInputEnabled: true,
      maxImagesPerMessage: 9
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
  public async replyText(): Promise<{
    platformMessageId: string;
    raw: Record<string, unknown>;
  }> {
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
