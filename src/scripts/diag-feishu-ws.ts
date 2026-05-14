import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as Lark from '@larksuiteoapi/node-sdk';

import { ensureRuntimeDirectories, loadAppConfig } from '../core/config/index.js';

type DiagnosticState = {
  startedAt: string;
  config: {
    runtimeRoot: string;
    domain: string;
    connectionMode: string;
    verificationTokenPresent: boolean;
    encryptKeyPresent: boolean;
  };
  sdkLogs: Array<{
    level: string;
    args: unknown[];
    at: string;
  }>;
  eventReceived: boolean;
  completedAt?: string;
};

async function main(): Promise<void> {
  const config = loadAppConfig('gateway');
  ensureRuntimeDirectories(config);

  const runtimeRoot =
    process.env.RUNTIME_ROOT?.trim() ||
    path.join(config.workspaceRoot, '.runtime', 'diag-feishu-ws');
  mkdirSync(runtimeRoot, { recursive: true });

  const outputPath = path.join(runtimeRoot, 'diag-feishu-ws.json');
  const state: DiagnosticState = {
    startedAt: new Date().toISOString(),
    config: {
      runtimeRoot,
      domain: config.feishu.domain,
      connectionMode: config.feishu.connectionMode,
      verificationTokenPresent: Boolean(config.feishu.verificationToken),
      encryptKeyPresent: Boolean(config.feishu.encryptKey)
    },
    sdkLogs: [],
    eventReceived: false
  };

  const logger = {
    error: (...args: unknown[]) => pushLog(state, 'error', args, outputPath),
    warn: (...args: unknown[]) => pushLog(state, 'warn', args, outputPath),
    info: (...args: unknown[]) => pushLog(state, 'info', args, outputPath),
    debug: (...args: unknown[]) => pushLog(state, 'debug', args, outputPath),
    trace: (...args: unknown[]) => pushLog(state, 'trace', args, outputPath)
  };

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: unknown) => {
      state.eventReceived = true;
      pushLog(state, 'event', [data], outputPath);
    }
  });

  const wsClient = new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain:
      config.feishu.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.debug,
    autoReconnect: true,
    logger
  });

  writeState(state, outputPath);

  try {
    await wsClient.start({
      eventDispatcher: dispatcher
    });
    await sleep(12000);
  } finally {
    try {
      wsClient.close({ force: true });
    } catch {
      // ignore
    }

    state.completedAt = new Date().toISOString();
    writeState(state, outputPath);
  }
}

function pushLog(
  state: DiagnosticState,
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

function writeState(state: DiagnosticState, outputPath: string): void {
  writeFileSync(outputPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
