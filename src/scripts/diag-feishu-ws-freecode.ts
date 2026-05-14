import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as Lark from '@larksuiteoapi/node-sdk';

type DiagState = {
  startedAt: string;
  appIdPresent: boolean;
  appSecretPresent: boolean;
  sdkLogs: Array<{
    level: string;
    args: unknown[];
    at: string;
  }>;
  connected: boolean;
  completedAt?: string;
};

function main(): Promise<void> {
  loadEnvFiles(process.cwd());

  const appId = process.env.FEISHU_APP_ID?.trim() || '';
  const appSecret = process.env.FEISHU_APP_SECRET?.trim() || '';
  const runtimeRoot =
    process.env.RUNTIME_ROOT?.trim() ||
    path.join(process.cwd(), '.runtime', 'diag-feishu-ws-freecode');
  mkdirSync(runtimeRoot, { recursive: true });
  const outputPath = path.join(runtimeRoot, 'diag-feishu-ws-freecode.json');

  const state: DiagState = {
    startedAt: new Date().toISOString(),
    appIdPresent: Boolean(appId),
    appSecretPresent: Boolean(appSecret),
    sdkLogs: [],
    connected: false
  };

  const logger = {
    error: (...args: unknown[]) => pushLog(state, 'error', args, outputPath),
    warn: (...args: unknown[]) => pushLog(state, 'warn', args, outputPath),
    info: (...args: unknown[]) => pushLog(state, 'info', args, outputPath),
    debug: (...args: unknown[]) => pushLog(state, 'debug', args, outputPath),
    trace: (...args: unknown[]) => pushLog(state, 'trace', args, outputPath)
  };

  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error
  });
  void client;

  const dispatcher = new Lark.EventDispatcher({
    encryptKey: '',
    verificationToken: '',
    loggerLevel: Lark.LoggerLevel.error
  }).register({
    'im.message.receive_v1': async (event: unknown) => {
      pushLog(state, 'event', [event], outputPath);
    }
  });

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error,
    autoReconnect: true,
    logger
  });

  writeState(state, outputPath);

  return wsClient
    .start({ eventDispatcher: dispatcher })
    .then(async () => {
      state.connected = true;
      pushLog(
        state,
        'info',
        ['free-code-style websocket connected'],
        outputPath
      );
      await sleep(5000);
    })
    .finally(() => {
      try {
        wsClient.close({ force: true });
      } catch {
        // ignore
      }
      state.completedAt = new Date().toISOString();
      writeState(state, outputPath);
    });
}

function loadEnvFiles(workspaceRoot: string): void {
  for (const envFile of ['.env', '.env.local']) {
    const fullPath = path.join(workspaceRoot, envFile);
    if (!existsSync(fullPath)) {
      continue;
    }

    const content = readFileSync(fullPath, 'utf8');
    for (const line of content.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function pushLog(
  state: DiagState,
  level: string,
  args: unknown[],
  outputPath: string
): void {
  state.sdkLogs.push({
    level,
    args,
    at: new Date().toISOString()
  });
  writeState(state, outputPath);
}

function writeState(state: DiagState, outputPath: string): void {
  writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
