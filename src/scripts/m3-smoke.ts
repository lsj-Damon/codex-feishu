import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AssistantWorkerService } from '../apps/assistant-worker/service.js';
import type { AppConfig } from '../core/config/index.js';
import { ensureRuntimeDirectories } from '../core/config/index.js';
import type { ConversationRecord } from '../core/types/domain.js';
import { openDatabase } from '../core/db/database.js';
import { runMigrations } from '../core/db/migrations.js';
import { HealthReporter } from '../core/health/reporter.js';
import { AppLogger } from '../core/logger/logger.js';
import { buildConversationContext } from '../domains/openai/context-builder.js';

async function main(): Promise<void> {
  await testContextBuilderPolicies();
  await testLocalFollowUpIntegration();
  console.log('M3 smoke checks passed.');
}

async function testContextBuilderPolicies(): Promise<void> {
  const clarificationContext = buildConversationContext({
    conversation: fakeConversation({
      id: 1,
      conversationKey: 'chat-1',
      chatId: 'chat-1',
      userOpenId: 'user-1',
      lastUserMessageId: 11,
      lastAssistantMessageId: 10,
      lastResponseId: 'resp-prev',
      summaryText: null,
      messageCount: 8
    }),
    messages: [
      fakeMessage(1, 'user', 'Node service startup error ECONNRESET'),
      fakeMessage(2, 'assistant', 'Check the full error and request path first.'),
      fakeMessage(3, 'user', 'I already retried and rotated the token, still failing.'),
      fakeMessage(4, 'assistant', 'Then inspect the call chain and retry logic.'),
      fakeMessage(5, 'user', 'help me look')
    ],
    maxContextMessages: 6,
    maxMessageChars: 1800,
    maxReplyChars: 900,
    summaryTriggerMessageCount: 4,
    summaryRefreshInterval: 2
  });

  assert.equal(clarificationContext.promptProfile, 'clarification');
  assert.ok(clarificationContext.followUpQuestion);
  assert.equal(clarificationContext.localReply, null);
  assert.equal(clarificationContext.previousResponseId, null);
  const hasSummarySignal = Boolean(
    clarificationContext.generatedSummaryText?.includes('Tech stack') ||
      clarificationContext.generatedSummaryText?.includes('Key errors')
  );
  assert.ok(hasSummarySignal);

  const continuationContext = buildConversationContext({
    conversation: fakeConversation({
      id: 2,
      conversationKey: 'chat-2',
      chatId: 'chat-2',
      userOpenId: 'user-2',
      lastUserMessageId: 21,
      lastAssistantMessageId: 20,
      lastResponseId: 'resp-cont',
      summaryText: 'Tech stack: TypeScript\nCurrent issue: SQL query syntax error',
      messageCount: 10
    }),
    messages: [
      fakeMessage(6, 'user', 'SQLSTATE 42601, is this where clause malformed?'),
      fakeMessage(7, 'assistant', 'This looks like a syntax issue.'),
      fakeMessage(8, 'user', 'I pasted the SQL, point out the exact error location.')
    ],
    maxContextMessages: 6,
    maxMessageChars: 1800,
    maxReplyChars: 900,
    summaryTriggerMessageCount: 8,
    summaryRefreshInterval: 4
  });

  assert.equal(continuationContext.promptProfile, 'error_analysis');
  assert.equal(continuationContext.followUpQuestion, null);
  assert.equal(continuationContext.localReply, null);
  assert.equal(continuationContext.previousResponseId, 'resp-cont');
  assert.equal(continuationContext.continuationMessages.length, 1);
  assert.ok(continuationContext.fallbackMessages.length >= 2);

  const metaContext = buildConversationContext({
    conversation: fakeConversation({
      id: 3,
      conversationKey: 'chat-3',
      chatId: 'chat-3',
      userOpenId: 'user-3',
      lastUserMessageId: 31,
      lastAssistantMessageId: 30,
      lastResponseId: 'resp-meta',
      summaryText: null,
      messageCount: 2
    }),
    messages: [fakeMessage(9, 'user', '你是谁')],
    maxContextMessages: 6,
    maxMessageChars: 1800,
    maxReplyChars: 900,
    summaryTriggerMessageCount: 8,
    summaryRefreshInterval: 4
  });
  assert.equal(metaContext.promptProfile, 'meta_assistant');
  assert.ok(metaContext.localReply?.length);
  assert.equal(metaContext.followUpQuestion, null);
  assert.equal(metaContext.previousResponseId, null);

  const longMetaContext = buildConversationContext({
    conversation: fakeConversation({
      id: 4,
      conversationKey: 'chat-4',
      chatId: 'chat-4',
      userOpenId: 'user-4',
      lastUserMessageId: 41,
      lastAssistantMessageId: 40,
      lastResponseId: 'resp-meta-2',
      summaryText: null,
      messageCount: 2
    }),
    messages: [
      fakeMessage(
        10,
        'user',
        'I want to see the records from this Feishu chat directly in the Codex UI, can I?'
      )
    ],
    maxContextMessages: 6,
    maxMessageChars: 1800,
    maxReplyChars: 900,
    summaryTriggerMessageCount: 8,
    summaryRefreshInterval: 4
  });
  assert.equal(longMetaContext.promptProfile, 'meta_assistant');
  assert.ok(longMetaContext.localReply?.length);
  assert.equal(longMetaContext.followUpQuestion, null);

  const imageContext = buildConversationContext({
    conversation: fakeConversation({
      id: 5,
      conversationKey: 'chat-5',
      chatId: 'chat-5',
      userOpenId: 'user-5',
      lastUserMessageId: 51,
      lastAssistantMessageId: 50,
      lastResponseId: 'resp-meta-3',
      summaryText: null,
      messageCount: 2
    }),
    messages: [fakeMessage(11, 'user', '[feishu:image]')],
    maxContextMessages: 6,
    maxMessageChars: 1800,
    maxReplyChars: 900,
    summaryTriggerMessageCount: 8,
    summaryRefreshInterval: 4
  });
  assert.equal(imageContext.promptProfile, 'image_analysis');
  assert.equal(imageContext.localReply, null);
  assert.equal(imageContext.followUpQuestion, null);
}

async function testLocalFollowUpIntegration(): Promise<void> {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'feishu-m3-smoke-'));
  try {
    const config = createTestConfig(runtimeRoot);
    ensureRuntimeDirectories(config);
    const logger = new AppLogger('m3-smoke', path.join(config.paths.logsDir, 'worker.log'));
    const database = openDatabase(config.paths.dbFile, logger);
    runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

    database
      .prepare(`
        INSERT INTO conversations (
          platform, conversation_key, chat_id, chat_type, user_open_id, status,
          workspace_root, current_project_name, current_project_path, active_backend,
          message_count, last_activity_at, created_at, updated_at
        ) VALUES ('feishu', 'chat-followup', 'chat-followup', 'p2p', 'user-followup', 'active',
          ?, ?, ?, 'codex', 0, ?, ?, ?)
      `)
      .run(
        'D:\\Develop\\workspace',
        'feishu-server',
        'D:\\Develop\\workspace\\feishu-server',
        nowIso(),
        nowIso(),
        nowIso()
      );
    const conversationId = Number(
      (database.prepare(`SELECT id FROM conversations WHERE conversation_key = 'chat-followup'`).get() as { id: number }).id
    );

    database
      .prepare(`
        INSERT INTO messages (
          platform, conversation_id, platform_message_id, reply_to_message_id,
          role, sender_open_id, content_text, content_json, token_input,
          token_output, model, response_id, status, created_at
        ) VALUES ('feishu', ?, 'msg-followup', NULL, 'user', 'user-followup', 'help me look', '{}', NULL, NULL, NULL, NULL, 'received', ?)
      `)
      .run(conversationId, nowIso());
    const triggerMessageId = Number(
      (database.prepare(`SELECT id FROM messages WHERE platform_message_id = 'msg-followup'`).get() as { id: number }).id
    );

    database
      .prepare(`
        UPDATE conversations
        SET last_user_message_id = ?, message_count = 1, last_response_id = 'resp-legacy', updated_at = ?
        WHERE id = ?
      `)
      .run(triggerMessageId, nowIso(), conversationId);

    database
      .prepare(`
        INSERT INTO jobs (
          job_type, conversation_id, trigger_message_id, status, priority,
          attempt_count, max_attempts, available_at, locked_by, lease_expires_at,
          last_error_code, last_error_message, result_message_id, created_at, updated_at
        ) VALUES ('reply_generation', ?, ?, 'queued', 0, 0, 4, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `)
      .run(conversationId, triggerMessageId, nowIso(), nowIso(), nowIso());

    const openAi = new FakeOpenAiClient();
    const feishu = new FakeFeishuMessageClient();
    const worker = new AssistantWorkerService(
      config,
      database,
      logger,
      feishu as any,
      openAi as any,
      new HealthReporter('worker', config.paths.healthFile)
    );

    const processed = await worker.runSingleIteration();
    assert.equal(processed, true);
    assert.equal(openAi.calls, 0, 'local follow-up should not call OpenAI');
    assert.equal(feishu.calls, 1, 'follow-up reply should still be delivered');

    const conversationRow = database.prepare('SELECT last_response_id, summary_text FROM conversations WHERE id = ?').get(conversationId) as {
      last_response_id: string | null;
      summary_text: string | null;
    };
    assert.equal(conversationRow.last_response_id, null);

    const assistantMessage = database.prepare(`SELECT content_text, content_json FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1`).get() as {
      content_text: string;
      content_json: string;
    };
    assert.match(assistantMessage.content_json, /local_follow_up/);

    database.close();
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

function fakeConversation(input: {
  id: number;
  conversationKey: string;
  chatId: string;
  userOpenId: string;
  lastUserMessageId: number;
  lastAssistantMessageId: number;
  lastResponseId: string | null;
  summaryText: string | null;
  messageCount: number;
}): ConversationRecord {
  return {
    id: input.id,
    platform: 'feishu',
    conversationKey: input.conversationKey,
    chatId: input.chatId,
    chatType: 'p2p',
    userOpenId: input.userOpenId,
    status: 'active',
    lastUserMessageId: input.lastUserMessageId,
    lastAssistantMessageId: input.lastAssistantMessageId,
    lastResponseId: input.lastResponseId,
    summaryText: input.summaryText,
    workspaceRoot: 'D:\\Develop\\workspace',
    currentProjectName: 'feishu-server',
    currentProjectPath: 'D:\\Develop\\workspace\\feishu-server',
    activeSessionId: null,
    activeBackend: 'codex',
    lastSwitchAt: null,
    messageCount: input.messageCount,
    lastActivityAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function fakeMessage(id: number, role: 'user' | 'assistant', contentText: string) {
  return {
    id,
    platform: 'feishu' as const,
    conversationId: 1,
    platformMessageId: `msg-${id}`,
    replyToMessageId: null,
    role,
    senderOpenId: role === 'user' ? 'user-1' : null,
    contentText,
    contentJson: null,
    tokenInput: null,
    tokenOutput: null,
    model: null,
    responseId: role === 'assistant' ? `resp-${id}` : null,
    status: 'sent',
    createdAt: nowIso()
  };
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
      summaryTriggerMessageCount: 4,
      summaryRefreshInterval: 2,
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
  public calls = 0;

  public async generateReply(): Promise<never> {
    this.calls += 1;
    throw new Error('OpenAI should not be called in this local follow-up scenario.');
  }
}

class FakeFeishuMessageClient {
  public calls = 0;

  public async replyText(): Promise<{ platformMessageId: string; raw: Record<string, unknown> }> {
    this.calls += 1;
    return {
      platformMessageId: `feishu-followup-${this.calls}`,
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
