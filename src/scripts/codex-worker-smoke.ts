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
import { FakeCodexCliClient } from '../domains/codex/fake-client.js';
import { createProgressMessageEvent } from '../domains/codex/stream-publisher.js';
import { CodexSessionManager } from '../domains/codex/session-manager.js';

async function main(): Promise<void> {
  const runtimeRoot = path.join(process.cwd(), '.runtime', 'codex-worker-smoke');
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });

  await testAnalyzeProjectAlias(runtimeRoot);
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });
  await testResumeSessionWithImage(runtimeRoot);
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });

  const workspaceRoot = path.join(runtimeRoot, 'workspace');
  const projectPath = path.join(workspaceRoot, 'alpha');
  mkdirSync(projectPath, { recursive: true });

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'codex-worker-smoke',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(
    database,
    workspaceRoot,
    'alpha',
    projectPath
  );
  const fakeFeishu = new FakeFeishuMessageClient();
  const fakeCodex = new FakeCodexCliClient([
    {
      sessionId: 'thread-broken-old',
      events: [],
      completion: {
        exitCode: null,
        finalMessageText: null,
        jsonlPath: path.join(runtimeRoot, 'worker-run-1.jsonl'),
        stderrPath: path.join(runtimeRoot, 'worker-run-1.stderr')
      },
      waitForCompletionError: new Error('resume failed: session not found')
    },
    {
      sessionId: 'thread-worker-2',
      events: [
        { type: 'thread.started', thread_id: 'thread-worker-2' },
        { type: 'turn.started' },
        createProgressMessageEvent('Scanning code structure'),
        createProgressMessageEvent('Inspecting entry files'),
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'Codex worker path verified.'
          }
        }
      ],
      completion: {
        exitCode: 0,
        finalMessageText: 'Codex worker path verified.',
        jsonlPath: path.join(runtimeRoot, 'worker-run-2.jsonl'),
        stderrPath: path.join(runtimeRoot, 'worker-run-2.stderr')
      }
    }
  ]);

  const seededSessionId = seedBrokenResumeSession(
    database,
    conversationId,
    projectPath
  );
  const triggerMessageId = seedUserMessage(database, conversationId, 'Analyze this project');
  const createdAt = nowIso();
  database.prepare(`
    UPDATE conversations
    SET last_user_message_id = ?, message_count = 1, last_activity_at = ?, updated_at = ?, active_session_id = ?
    WHERE id = ?
  `).run(triggerMessageId, createdAt, createdAt, seededSessionId, conversationId);
  database.prepare(`
    INSERT INTO jobs (
      job_type, conversation_id, trigger_message_id, status, priority,
      attempt_count, max_attempts, available_at, locked_by, lease_expires_at,
      last_error_code, last_error_message, result_message_id, created_at, updated_at
    ) VALUES ('reply_generation', ?, ?, 'queued', 0, 0, 4, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `).run(conversationId, triggerMessageId, createdAt, createdAt, createdAt);

  const worker = new AssistantWorkerService(
    config,
    database,
    logger,
    fakeFeishu as any,
    null,
    new HealthReporter('worker', config.paths.healthFile),
    fakeCodex
  );

  const processed = await worker.runSingleIteration();
  assert.equal(processed, true);
  assert.equal(fakeFeishu.sent.length >= 3, true);
  assert.match(fakeFeishu.sent.at(-1) ?? '', /Codex worker path verified/);

  const conversationRow = database.prepare(`
    SELECT active_session_id
    FROM conversations
    WHERE id = ?
  `).get(conversationId) as { active_session_id: number | null };
  assert.equal(typeof conversationRow.active_session_id, 'number');
  assert.notEqual(conversationRow.active_session_id, seededSessionId);

  const newSessionRow = database.prepare(`
    SELECT codex_session_id, status
    FROM codex_sessions
    WHERE id = ?
  `).get(conversationRow.active_session_id) as {
    codex_session_id: string;
    status: string;
  };
  assert.equal(newSessionRow.codex_session_id, 'thread-worker-2');
  assert.equal(newSessionRow.status, 'active');

  const oldSessionRow = database.prepare(`
    SELECT status
    FROM codex_sessions
    WHERE id = ?
  `).get(seededSessionId) as { status: string };
  assert.equal(oldSessionRow.status, 'broken');

  const sessionManager = new CodexSessionManager(database);
  const summary = sessionManager.getRunSummaryByJobId(1);
  assert.equal(summary.attemptCount, 2);
  assert.equal(summary.failedAttemptCount, 1);
  assert.equal(summary.latestSuccessfulRun?.finalReplyText, 'Codex worker path verified.');

  database.close();
  console.log('Codex worker smoke checks passed.');
}

async function testAnalyzeProjectAlias(runtimeRoot: string): Promise<void> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace-alias');
  const projectPath = path.join(workspaceRoot, 'alpha');
  mkdirSync(projectPath, { recursive: true });

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'codex-worker-smoke-alias',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(
    database,
    workspaceRoot,
    'alpha',
    projectPath,
    'chat-codex-worker-alias'
  );
  const fakeFeishu = new FakeFeishuMessageClient();
  const fakeCodex = new AssertingCodexCliClient('/understand --language zh');

  const triggerMessageId = seedUserMessage(database, conversationId, '分析项目');
  const createdAt = nowIso();
  database.prepare(`
    UPDATE conversations
    SET last_user_message_id = ?, message_count = 1, last_activity_at = ?, updated_at = ?
    WHERE id = ?
  `).run(triggerMessageId, createdAt, createdAt, conversationId);
  database.prepare(`
    INSERT INTO jobs (
      job_type, conversation_id, trigger_message_id, status, priority,
      attempt_count, max_attempts, available_at, locked_by, lease_expires_at,
      last_error_code, last_error_message, result_message_id, created_at, updated_at
    ) VALUES ('reply_generation', ?, ?, 'queued', 0, 0, 4, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `).run(conversationId, triggerMessageId, createdAt, createdAt, createdAt);

  const worker = new AssistantWorkerService(
    config,
    database,
    logger,
    fakeFeishu as any,
    null,
    new HealthReporter('worker', config.paths.healthFile),
    fakeCodex
  );

  const processed = await worker.runSingleIteration();
  assert.equal(processed, true);
  fakeCodex.assertExpectedPrompt();
  assert.equal(fakeFeishu.sent.length >= 2, true);

  database.close();
}

function seedConversation(
  database: ReturnType<typeof openDatabase>,
  workspaceRoot: string,
  projectName: string,
  projectPath: string,
  conversationKey = 'chat-codex-worker'
): number {
  const createdAt = nowIso();
  database.prepare(`
    INSERT INTO conversations (
      platform, conversation_key, chat_id, chat_type, user_open_id, status,
      workspace_root, current_project_name, current_project_path, active_backend,
      message_count, last_activity_at, created_at, updated_at
    ) VALUES ('feishu', ?, ?, 'p2p', 'user-1', 'active',
      ?, ?, ?, 'codex', 0, ?, ?, ?)
  `).run(
    conversationKey,
    conversationKey,
    workspaceRoot,
    projectName,
    projectPath,
    createdAt,
    createdAt,
    createdAt
  );

  return Number(
    (
      database
        .prepare(`SELECT id FROM conversations WHERE conversation_key = ?`)
        .get(conversationKey) as { id: number }
    ).id
  );
}

function seedBrokenResumeSession(
  database: ReturnType<typeof openDatabase>,
  conversationId: number,
  projectPath: string
): number {
  const createdAt = nowIso();
  database.prepare(`
    INSERT INTO codex_sessions (
      conversation_id, project_name, project_path, codex_session_id, status,
      created_at, last_active_at, archived_at
    ) VALUES (?, 'alpha', ?, 'thread-broken-old', 'active', ?, ?, NULL)
  `).run(conversationId, projectPath, createdAt, createdAt);

  return Number(
    (
      database
        .prepare(`SELECT id FROM codex_sessions WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`)
        .get(conversationId) as { id: number }
    ).id
  );
}

function seedUserMessage(
  database: ReturnType<typeof openDatabase>,
  conversationId: number,
  contentText: string
): number {
  const createdAt = nowIso();
  database.prepare(`
    INSERT INTO messages (
      platform, conversation_id, platform_message_id, reply_to_message_id,
      role, sender_open_id, content_text, content_json, token_input, token_output,
      model, response_id, status, created_at
    ) VALUES ('feishu', ?, ?, NULL, 'user', 'user-1', ?, '{}', NULL, NULL, NULL, NULL, 'received', ?)
  `).run(conversationId, `msg-${Date.now()}`, contentText, createdAt);

  return Number(
    (
      database
        .prepare(`SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`)
        .get(conversationId) as { id: number }
    ).id
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
      model: 'gpt-5.4-mini'
    },
    codex: {
      workspaceRoot,
      cliPath: 'codex',
      execTimeoutMs: 600000,
      maxProgressMessageIntervalMs: 0,
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

class FakeFeishuMessageClient {
  public readonly sent: string[] = [];
  public downloadCalls = 0;

  public async replyText(input: {
    text: string;
  }): Promise<{ platformMessageId: string; raw: Record<string, unknown> }> {
    this.sent.push(input.text);
    return {
      platformMessageId: `reply-${this.sent.length}`,
      raw: {}
    };
  }

  public async downloadImage(
    _messageId: string,
    _imageKey: string,
    localPath: string
  ): Promise<void> {
    this.downloadCalls += 1;
    writeFileSync(localPath, createTinyPngBuffer());
  }
}

class AssertingCodexCliClient extends FakeCodexCliClient {
  private readonly expectedPromptText: string;
  public seenPromptText: string | null = null;

  public constructor(expectedPromptText: string) {
    const runtimeRoot = path.join(process.cwd(), '.runtime');
    super([
      {
        sessionId: 'thread-analyze-project',
        events: [
          { type: 'thread.started', thread_id: 'thread-analyze-project' },
          { type: 'turn.started' },
          createProgressMessageEvent('Running project understanding'),
          {
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: 'Project understanding complete.'
            }
          }
        ],
        completion: {
          exitCode: 0,
          finalMessageText: 'Project understanding complete.',
          jsonlPath: path.join(runtimeRoot, 'worker-alias.jsonl'),
          stderrPath: path.join(runtimeRoot, 'worker-alias.stderr')
        }
      }
    ]);
    this.expectedPromptText = expectedPromptText;
  }

  public override async runNewSession(input: {
    workspaceRoot: string;
    promptText: string;
    outputDir: string;
    timeoutMs: number;
  }) {
    this.seenPromptText = input.promptText;
    return super.runNewSession(input);
  }

  public assertExpectedPrompt(): void {
    assert.match(this.seenPromptText ?? '', new RegExp(this.expectedPromptText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

async function testResumeSessionWithImage(runtimeRoot: string): Promise<void> {
  const workspaceRoot = path.join(runtimeRoot, 'workspace-image');
  const projectPath = path.join(workspaceRoot, 'alpha');
  mkdirSync(projectPath, { recursive: true });

  const config = createTestConfig(runtimeRoot, workspaceRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'codex-worker-smoke-image',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const conversationId = seedConversation(
    database,
    workspaceRoot,
    'alpha',
    projectPath,
    'chat-codex-worker-image'
  );
  const sessionId = seedHealthyResumeSession(
    database,
    conversationId,
    projectPath,
    'thread-image-resume'
  );
  const triggerMessageId = seedUserMessage(
    database,
    conversationId,
    'I attached the latest run screenshot, analyze it and fix the issue.'
  );
  seedImageAttachment(database, triggerMessageId, 'img_resume_1');
  const createdAt = nowIso();
  database.prepare(`
    UPDATE conversations
    SET last_user_message_id = ?, message_count = 1, last_activity_at = ?, updated_at = ?, active_session_id = ?
    WHERE id = ?
  `).run(triggerMessageId, createdAt, createdAt, sessionId, conversationId);
  database.prepare(`
    INSERT INTO jobs (
      job_type, conversation_id, trigger_message_id, status, priority,
      attempt_count, max_attempts, available_at, locked_by, lease_expires_at,
      last_error_code, last_error_message, result_message_id, created_at, updated_at
    ) VALUES ('reply_generation', ?, ?, 'queued', 0, 0, 4, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `).run(conversationId, triggerMessageId, createdAt, createdAt, createdAt);

  const fakeFeishu = new FakeFeishuMessageClient();
  const fakeCodex = new FakeCodexCliClient([
    {
      sessionId: 'thread-image-resume',
      events: [
        { type: 'turn.started' },
        createProgressMessageEvent('Reviewing attached screenshot'),
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: 'The screenshot confirms the failing state. I updated the relevant code path.'
          }
        }
      ],
      completion: {
        exitCode: 0,
        finalMessageText:
          'The screenshot confirms the failing state. I updated the relevant code path.',
        jsonlPath: path.join(runtimeRoot, 'resume-image.jsonl'),
        stderrPath: path.join(runtimeRoot, 'resume-image.stderr')
      }
    }
  ]);
  const worker = new AssistantWorkerService(
    config,
    database,
    logger,
    fakeFeishu as any,
    null,
    new HealthReporter('worker', config.paths.healthFile),
    fakeCodex
  );

  const processed = await worker.runSingleIteration();
  assert.equal(processed, true);
  assert.equal(fakeFeishu.downloadCalls, 1);
  assert.equal(fakeCodex.resumeSessionInputs.length, 1);
  assert.equal(fakeCodex.runNewSessionInputs.length, 0);
  assert.equal(fakeCodex.resumeSessionInputs[0]?.imagePaths?.length, 1);
  assert.ok(
    fakeCodex.resumeSessionInputs[0]?.imagePaths?.[0]?.endsWith(
      'img_resume_1.bin'
    )
  );
  assert.match(
    fakeCodex.resumeSessionInputs[0]?.promptText ?? '',
    /downloaded successfully and attached to this turn/i
  );
  assert.doesNotMatch(
    fakeCodex.resumeSessionInputs[0]?.promptText ?? '',
    /图片附件当前不通|截图附件没有成功传到|Screenshot attachment warning/i
  );

  const attachmentRow = database.prepare(`
    SELECT status, mime_type, local_path
    FROM message_attachments
    WHERE message_id = ?
  `).get(triggerMessageId) as {
    status: string;
    mime_type: string | null;
    local_path: string | null;
  };
  assert.equal(attachmentRow.status, 'downloaded');
  assert.equal(attachmentRow.mime_type, 'image/png');
  assert.ok((attachmentRow.local_path ?? '').endsWith('img_resume_1.bin'));

  database.close();
}

function seedHealthyResumeSession(
  database: ReturnType<typeof openDatabase>,
  conversationId: number,
  projectPath: string,
  codexSessionId: string
): number {
  const createdAt = nowIso();
  database.prepare(`
    INSERT INTO codex_sessions (
      conversation_id, project_name, project_path, codex_session_id, status,
      created_at, last_active_at, archived_at
    ) VALUES (?, 'alpha', ?, ?, 'active', ?, ?, NULL)
  `).run(conversationId, projectPath, codexSessionId, createdAt, createdAt);

  return Number(
    (
      database
        .prepare(`SELECT id FROM codex_sessions WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`)
        .get(conversationId) as { id: number }
    ).id
  );
}

function seedImageAttachment(
  database: ReturnType<typeof openDatabase>,
  messageId: number,
  remoteKey: string
): void {
  const createdAt = nowIso();
  database.prepare(`
    INSERT INTO message_attachments (
      message_id, attachment_index, provider, attachment_kind, remote_key,
      local_path, mime_type, status, width, height, metadata_json,
      last_error_message, created_at, updated_at
    ) VALUES (?, 0, 'feishu', 'image', ?, NULL, NULL, 'pending', NULL, NULL, ?, NULL, ?, ?)
  `).run(
    messageId,
    remoteKey,
    JSON.stringify({ image_key: remoteKey }),
    createdAt,
    createdAt
  );
}

function createTinyPngBuffer(): Buffer {
  return Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6360000002000154A24F5D0000000049454E44AE426082',
    'hex'
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
