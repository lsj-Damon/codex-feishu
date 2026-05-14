import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { BotGatewayService } from '../apps/bot-gateway/service.js';
import { AssistantWorkerService } from '../apps/assistant-worker/service.js';
import type { AppConfig } from '../core/config/index.js';
import { ensureRuntimeDirectories } from '../core/config/index.js';
import { openDatabase } from '../core/db/database.js';
import { runMigrations } from '../core/db/migrations.js';
import { HealthReporter } from '../core/health/reporter.js';
import { AppLogger } from '../core/logger/logger.js';

async function main(): Promise<void> {
  const runtimeRoot = path.join(process.cwd(), '.runtime', 'm2-smoke');
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });

  await testGatewayIdempotencyAndGroupPolicy(runtimeRoot);
  await testGatewayFlatWebsocketEvent(runtimeRoot);
  await testDeliveryOnlyRetry(runtimeRoot);
  await testExpiredLeaseRecovery(runtimeRoot);

  console.log('M2 smoke checks passed.');
}

async function testGatewayIdempotencyAndGroupPolicy(runtimeRoot: string): Promise<void> {
  const config = createTestConfig(path.join(runtimeRoot, 'gateway-policy'));
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'm2-smoke-gateway',
    path.join(config.paths.logsDir, 'gateway.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const gateway = new BotGatewayService(
    config,
    database,
    logger,
    {
      start: async () => undefined,
      stop: async () => undefined
    } as any,
    new HealthReporter('gateway', path.join(config.paths.runDir, 'gateway.health.json'))
  );

  await gateway.processIncomingPayload(
    createMessageEvent({
      eventId: 'evt-p2p-1',
      messageId: 'msg-p2p-1',
      chatId: 'chat-p2p-1',
      chatType: 'p2p',
      senderOpenId: 'user-a',
      text: 'hello'
    })
  );
  await gateway.processIncomingPayload(
    createMessageEvent({
      eventId: 'evt-p2p-2',
      messageId: 'msg-p2p-1',
      chatId: 'chat-p2p-1',
      chatType: 'p2p',
      senderOpenId: 'user-a',
      text: 'hello duplicate'
    })
  );
  await gateway.processIncomingPayload(
    createMessageEvent({
      eventId: 'evt-group-1',
      messageId: 'msg-group-1',
      chatId: 'chat-group-1',
      chatType: 'group',
      senderOpenId: 'user-b',
      text: 'not mentioned'
    })
  );
  await gateway.processIncomingPayload(
    createMessageEvent({
      eventId: 'evt-group-2',
      messageId: 'msg-group-2',
      chatId: 'chat-group-1',
      chatType: 'group',
      senderOpenId: 'user-b',
      text: '@bot hi',
      mentionOpenIds: ['bot_open_id']
    })
  );

  const jobCount = Number(
    (database.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count
  );
  const messageCount = Number(
    (database.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count
  );
  assert.equal(jobCount, 2);
  assert.equal(messageCount, 2);

  database.close();
}

async function testGatewayFlatWebsocketEvent(runtimeRoot: string): Promise<void> {
  const config = createTestConfig(path.join(runtimeRoot, 'gateway-flat'));
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'm2-smoke-flat',
    path.join(config.paths.logsDir, 'gateway.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const gateway = new BotGatewayService(
    config,
    database,
    logger,
    {
      start: async () => undefined,
      stop: async () => undefined
    } as any,
    new HealthReporter(
      'gateway',
      path.join(config.paths.runDir, 'gateway.health.json')
    )
  );

  await gateway.processIncomingPayload({
    sender: {
      sender_id: {
        open_id: 'user-flat'
      },
      sender_type: 'user'
    },
    message: {
      message_id: 'msg-flat-1',
      chat_id: 'chat-flat-1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({
        text: 'flat websocket event'
      }),
      mentions: []
    }
  });

  const jobCount = Number(
    (database.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
      count: number;
    }).count
  );
  assert.equal(jobCount, 1);

  database.close();
}

async function testDeliveryOnlyRetry(runtimeRoot: string): Promise<void> {
  const config = createTestConfig(path.join(runtimeRoot, 'delivery-retry'));
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'm2-smoke-delivery',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const gateway = new BotGatewayService(
    config,
    database,
    logger,
    {
      start: async () => undefined,
      stop: async () => undefined
    } as any,
    new HealthReporter('gateway', path.join(config.paths.runDir, 'gateway.health.json'))
  );

  await gateway.processIncomingPayload(
    createMessageEvent({
      eventId: 'evt-retry-1',
      messageId: 'msg-retry-1',
      chatId: 'chat-retry-1',
      chatType: 'p2p',
      senderOpenId: 'user-c',
      text: 'Node 服务报错 ECONNRESET，帮我分析原因'
    })
  );

  const fakeOpenAi = new FakeOpenAiClient();
  const fakeFeishu = new FakeFeishuMessageClient({ failFirst: true });
  const worker = new AssistantWorkerService(
    config,
    database,
    logger,
    fakeFeishu as any,
    fakeOpenAi as any,
    new HealthReporter('worker', config.paths.healthFile)
  );

  await worker.runSingleIteration();
  let job = database.prepare('SELECT status FROM jobs LIMIT 1').get() as { status: string };
  let delivery = database.prepare('SELECT status FROM deliveries LIMIT 1').get() as { status: string };
  assert.equal(job.status, 'retry_wait');
  assert.equal(delivery.status, 'retry_wait');
  assert.equal(fakeOpenAi.calls, 1);
  assert.equal(fakeFeishu.calls, 1);

  await worker.runSingleIteration();
  job = database.prepare('SELECT status FROM jobs LIMIT 1').get() as { status: string };
  delivery = database.prepare('SELECT status FROM deliveries LIMIT 1').get() as { status: string };
  assert.equal(job.status, 'succeeded');
  assert.equal(delivery.status, 'succeeded');
  assert.equal(fakeOpenAi.calls, 1);
  assert.equal(fakeFeishu.calls, 2);

  database.close();
}

async function testExpiredLeaseRecovery(runtimeRoot: string): Promise<void> {
  const config = createTestConfig(path.join(runtimeRoot, 'lease-recovery'));
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'm2-smoke-lease',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);
  runMigrations(database, path.join(process.cwd(), 'migrations'), logger);

  const gateway = new BotGatewayService(
    config,
    database,
    logger,
    {
      start: async () => undefined,
      stop: async () => undefined
    } as any,
    new HealthReporter('gateway', path.join(config.paths.runDir, 'gateway.health.json'))
  );

  await gateway.processIncomingPayload(
    createMessageEvent({
      eventId: 'evt-lease-1',
      messageId: 'msg-lease-1',
      chatId: 'chat-lease-1',
      chatType: 'p2p',
      senderOpenId: 'user-d',
      text: 'recover me'
    })
  );

  database
    .prepare(`
      UPDATE jobs
      SET status = 'running',
          locked_by = 'dead-worker',
          lease_expires_at = '2000-01-01T00:00:00.000Z',
          attempt_count = 1
    `)
    .run();

  const worker = new AssistantWorkerService(
    config,
    database,
    logger,
    new FakeFeishuMessageClient() as any,
    new FakeOpenAiClient() as any,
    new HealthReporter('worker', config.paths.healthFile)
  );

  await worker.runSingleIteration();
  const job = database.prepare('SELECT status FROM jobs LIMIT 1').get() as { status: string };
  assert.equal(job.status, 'succeeded');

  database.close();
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

function createMessageEvent(input: {
  eventId: string;
  messageId: string;
  chatId: string;
  chatType: string;
  senderOpenId: string;
  text: string;
  mentionOpenIds?: string[];
}): Record<string, unknown> {
  return {
    header: {
      event_id: input.eventId,
      event_type: 'im.message.receive_v1'
    },
    event: {
      sender: {
        sender_id: {
          open_id: input.senderOpenId
        },
        sender_type: 'user'
      },
      message: {
        message_id: input.messageId,
        chat_id: input.chatId,
        chat_type: input.chatType,
        message_type: 'text',
        content: JSON.stringify({
          text: input.text
        }),
        mentions: (input.mentionOpenIds ?? []).map((openId) => ({
          id: {
            open_id: openId
          }
        }))
      }
    }
  };
}

class FakeOpenAiClient {
  public calls = 0;

  public async generateReply(): Promise<{
    text: string;
    responseId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    this.calls += 1;
    return {
      text: 'mock reply',
      responseId: `resp-${this.calls}`,
      model: 'gpt-5.4-mini',
      inputTokens: 10,
      outputTokens: 20
    };
  }
}

class FakeFeishuMessageClient {
  public calls = 0;

  public constructor(private readonly behavior: { failFirst?: boolean } = {}) {}

  public async replyText(): Promise<{
    platformMessageId: string;
    raw: Record<string, unknown>;
  }> {
    this.calls += 1;
    if (this.behavior.failFirst && this.calls === 1) {
      const error = new Error('temporary delivery failure') as Error & {
        status?: number;
      };
      error.status = 503;
      throw error;
    }

    return {
      platformMessageId: `feishu-reply-${this.calls}`,
      raw: {}
    };
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
