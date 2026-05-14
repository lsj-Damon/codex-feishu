import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  const runtimeRoot = path.join(process.cwd(), '.runtime', 'image-mvp-smoke');
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });

  const config = createTestConfig(runtimeRoot);
  ensureRuntimeDirectories(config);
  const logger = new AppLogger(
    'image-mvp-smoke',
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

  await gateway.processIncomingPayload({
    sender: {
      sender_id: {
        open_id: 'user-image'
      },
      sender_type: 'user'
    },
    message: {
      message_id: 'msg-image-1',
      chat_id: 'chat-image-1',
      chat_type: 'p2p',
      message_type: 'image',
      content: JSON.stringify({
        image_key: 'img_test_single'
      }),
      mentions: []
    }
  });

  const attachmentCount = Number(
    (database.prepare('SELECT COUNT(*) AS count FROM message_attachments').get() as { count: number }).count
  );
  assert.equal(attachmentCount, 1);

  const fakeOpenAi = new FakeOpenAiClient();
  const fakeFeishu = new FakeFeishuMessageClient();
  const workerLogger = new AppLogger(
    'image-mvp-smoke-worker',
    path.join(config.paths.logsDir, 'worker.log')
  );
  const worker = new AssistantWorkerService(
    config,
    database,
    workerLogger,
    fakeFeishu as any,
    fakeOpenAi as any,
    new HealthReporter('worker', config.paths.healthFile)
  );

  await worker.runSingleIteration();

  assert.equal(fakeFeishu.replyCalls, 1);
  assert.equal(fakeFeishu.downloadCalls, 1);
  assert.equal(fakeOpenAi.calls, 1);
  assert.equal(fakeOpenAi.lastTriggerImages?.length, 1);
  assert.ok(fakeOpenAi.lastTriggerImages?.[0]?.dataUrl.startsWith('data:image/png;base64,'));

  const downloadedCount = Number(
    (database.prepare("SELECT COUNT(*) AS count FROM message_attachments WHERE status = 'downloaded'").get() as { count: number }).count
  );
  assert.equal(downloadedCount, 1);

  console.log('Single-image MVP smoke checks passed.');
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

class FakeFeishuMessageClient {
  public replyCalls = 0;
  public downloadCalls = 0;

  public async replyText(): Promise<{
    platformMessageId: string;
    raw: Record<string, unknown>;
  }> {
    this.replyCalls += 1;
    return {
      platformMessageId: `reply-${this.replyCalls}`,
      raw: {}
    };
  }

  public async downloadImage(_imageKey: string, localPath: string): Promise<void> {
    this.downloadCalls += 1;
    writeFileSync(localPath, createTinyPngBuffer());
  }
}

class FakeOpenAiClient {
  public calls = 0;
  public lastTriggerImages:
    | Array<{ dataUrl: string; mimeType: string }>
    | undefined;

  public async generateReply(input: {
    triggerImages?: Array<{ dataUrl: string; mimeType: string }>;
  }): Promise<{
    text: string;
    responseId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    usedPreviousResponseId: boolean;
    fellBackFromPreviousResponseId: boolean;
  }> {
    this.calls += 1;
    this.lastTriggerImages = input.triggerImages;
    return {
      text: '这张图片里是报错截图，建议先看报错关键字和对应代码位置。',
      responseId: `resp-${this.calls}`,
      model: 'gpt-5.4-mini',
      inputTokens: 10,
      outputTokens: 20,
      usedPreviousResponseId: false,
      fellBackFromPreviousResponseId: false
    };
  }
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
