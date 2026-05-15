import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { AppRole } from '../types/domain.js';

export interface AppConfig {
  role: AppRole;
  workspaceRoot: string;
  runtimeRoot: string;
  paths: {
    configDir: string;
    dataDir: string;
    dbFile: string;
    attachmentsDir: string;
    imageAttachmentsDir: string;
    backupsDir: string;
    logsDir: string;
    logFile: string;
    runDir: string;
    healthFile: string;
  };
  configFiles: {
    defaultFile: string;
    localFile: string;
  };
  feishu: {
    appId: string;
    appSecret: string;
    verificationToken?: string;
    encryptKey?: string;
    botOpenId?: string;
    connectionMode: 'websocket' | 'webhook';
    domain: 'feishu' | 'lark';
    bindHost: string;
    bindPort: number;
    callbackPath: string;
    publicBaseUrl?: string;
  };
  triggerPolicy: {
    allowGroups: boolean;
    allowedChatIds: string[];
    allowedUserIds: string[];
  };
  openai: {
    apiKey?: string;
    model: string;
    baseUrl?: string;
  };
  codex: {
    workspaceRoot: string;
    cliPath: string;
    execTimeoutMs: number;
    maxProgressMessageIntervalMs: number;
    maxOutputChars: number;
  };
  worker: {
    pollIntervalMs: number;
    leaseDurationMs: number;
    leaseRenewIntervalMs: number;
    maxContextMessages: number;
    maxMessageChars: number;
    maxReplyChars: number;
    summaryTriggerMessageCount: number;
    summaryRefreshInterval: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxDelayMs: number;
    imageInputEnabled: boolean;
    maxImagesPerMessage: number;
  };
  maintenance: {
    backupKeepCount: number;
    rawEventRetentionDays: number;
    deliveryRetentionDays: number;
    jobRetentionDays: number;
    logRetentionDays: number;
  };
}

type FileConfigOverrides = {
  feishu?: {
    connectionMode?: 'websocket' | 'webhook';
    domain?: 'feishu' | 'lark';
    bindHost?: string;
    bindPort?: number;
    callbackPath?: string;
    publicBaseUrl?: string;
  };
  triggerPolicy?: {
    allowGroups?: boolean;
    allowedChatIds?: string[];
    allowedUserIds?: string[];
  };
  openai?: {
    model?: string;
    baseUrl?: string;
  };
  codex?: {
    workspaceRoot?: string;
    cliPath?: string;
    execTimeoutMs?: number;
    maxProgressMessageIntervalMs?: number;
    maxOutputChars?: number;
  };
  worker?: {
    pollIntervalMs?: number;
    leaseDurationMs?: number;
    leaseRenewIntervalMs?: number;
    maxContextMessages?: number;
    maxMessageChars?: number;
    maxReplyChars?: number;
    summaryTriggerMessageCount?: number;
    summaryRefreshInterval?: number;
    maxAttempts?: number;
    retryBaseMs?: number;
    retryMaxDelayMs?: number;
    maxImagesPerMessage?: number;
  };
  maintenance?: {
    backupKeepCount?: number;
    rawEventRetentionDays?: number;
    deliveryRetentionDays?: number;
    jobRetentionDays?: number;
    logRetentionDays?: number;
  };
};

export function loadAppConfig(role: AppRole): AppConfig {
  const workspaceRoot = process.cwd();
  loadEnvFiles(workspaceRoot);

  const localAppData = process.env.LOCALAPPDATA;
  const runtimeRoot =
    process.env.RUNTIME_ROOT?.trim() ||
    (localAppData
      ? path.join(localAppData, 'FeishuCodexBot')
      : path.join(workspaceRoot, '.runtime', 'FeishuCodexBot'));

  const defaultFile = path.join(workspaceRoot, 'config', 'default.json');
  const localFile = path.join(runtimeRoot, 'config', 'local.json');
  const fileConfig = loadFileConfigOverrides(defaultFile, localFile);

  const config: AppConfig = {
    role,
    workspaceRoot,
    runtimeRoot,
    paths: {
      configDir: path.join(runtimeRoot, 'config'),
      dataDir: path.join(runtimeRoot, 'data'),
      dbFile: path.join(runtimeRoot, 'data', 'app.db'),
      attachmentsDir: path.join(runtimeRoot, 'data', 'attachments'),
      imageAttachmentsDir: path.join(runtimeRoot, 'data', 'attachments', 'images'),
      backupsDir: path.join(runtimeRoot, 'backups'),
      logsDir: path.join(runtimeRoot, 'logs'),
      logFile: path.join(runtimeRoot, 'logs', `${role}.log`),
      runDir: path.join(runtimeRoot, 'run'),
      healthFile: path.join(runtimeRoot, 'run', `${role}.health.json`)
    },
    configFiles: {
      defaultFile,
      localFile
    },
    feishu: {
      appId: requiredEnv('FEISHU_APP_ID'),
      appSecret: requiredEnv('FEISHU_APP_SECRET'),
      verificationToken: optionalEnv('FEISHU_VERIFICATION_TOKEN'),
      encryptKey: optionalEnv('FEISHU_ENCRYPT_KEY'),
      botOpenId: optionalEnv('FEISHU_BOT_OPEN_ID'),
      connectionMode:
        (optionalEnv('FEISHU_CONNECTION_MODE') ??
          fileConfig.feishu?.connectionMode) === 'webhook'
          ? 'webhook'
          : 'websocket',
      domain:
        (optionalEnv('FEISHU_DOMAIN') ?? fileConfig.feishu?.domain) === 'lark'
          ? 'lark'
          : 'feishu',
      bindHost:
        optionalEnv('FEISHU_BIND_HOST') ??
        fileConfig.feishu?.bindHost ??
        '127.0.0.1',
      bindPort: parseIntegerConfig(
        'FEISHU_BIND_PORT',
        fileConfig.feishu?.bindPort,
        39876
      ),
      callbackPath:
        optionalEnv('FEISHU_CALLBACK_PATH') ??
        fileConfig.feishu?.callbackPath ??
        '/feishu/events',
      publicBaseUrl:
        optionalEnv('FEISHU_PUBLIC_BASE_URL') ??
        fileConfig.feishu?.publicBaseUrl
    },
    triggerPolicy: {
      allowGroups: parseBooleanConfig(
        'ALLOW_GROUPS',
        fileConfig.triggerPolicy?.allowGroups,
        false
      ),
      allowedChatIds: parseCsvConfig(
        'ALLOWED_CHAT_IDS',
        fileConfig.triggerPolicy?.allowedChatIds
      ),
      allowedUserIds: parseCsvConfig(
        'ALLOWED_USER_IDS',
        fileConfig.triggerPolicy?.allowedUserIds
      )
    },
    openai: {
      apiKey: optionalEnv('OPENAI_API_KEY'),
      model:
        optionalEnv('OPENAI_MODEL') ??
        fileConfig.openai?.model ??
        'gpt-5.4-mini',
      baseUrl: optionalEnv('OPENAI_BASE_URL') ?? fileConfig.openai?.baseUrl
    },
    codex: {
      workspaceRoot:
        optionalEnv('CODEX_WORKSPACE_ROOT') ??
        fileConfig.codex?.workspaceRoot ??
        'D:\\Develop\\workspace',
      cliPath:
        optionalEnv('CODEX_CLI_PATH') ??
        fileConfig.codex?.cliPath ??
        'codex',
      execTimeoutMs: parseIntegerConfig(
        'CODEX_EXEC_TIMEOUT_MS',
        fileConfig.codex?.execTimeoutMs,
        600000
      ),
      maxProgressMessageIntervalMs: parseIntegerConfig(
        'CODEX_MAX_PROGRESS_MESSAGE_INTERVAL_MS',
        fileConfig.codex?.maxProgressMessageIntervalMs,
        3000
      ),
      maxOutputChars: parseIntegerConfig(
        'CODEX_MAX_OUTPUT_CHARS',
        fileConfig.codex?.maxOutputChars,
        4000
      )
    },
    worker: {
      pollIntervalMs: parseIntegerConfig(
        'WORKER_POLL_INTERVAL_MS',
        fileConfig.worker?.pollIntervalMs,
        1000
      ),
      leaseDurationMs: parseIntegerConfig(
        'WORKER_LEASE_DURATION_MS',
        fileConfig.worker?.leaseDurationMs,
        120000
      ),
      leaseRenewIntervalMs: parseIntegerConfig(
        'WORKER_LEASE_RENEW_INTERVAL_MS',
        fileConfig.worker?.leaseRenewIntervalMs,
        20000
      ),
      maxContextMessages: parseIntegerConfig(
        'WORKER_MAX_CONTEXT_MESSAGES',
        fileConfig.worker?.maxContextMessages,
        10
      ),
      maxMessageChars: parseIntegerConfig(
        'WORKER_MAX_MESSAGE_CHARS',
        fileConfig.worker?.maxMessageChars,
        1800
      ),
      maxReplyChars: parseIntegerConfig(
        'WORKER_MAX_REPLY_CHARS',
        fileConfig.worker?.maxReplyChars,
        900
      ),
      summaryTriggerMessageCount: parseIntegerConfig(
        'WORKER_SUMMARY_TRIGGER_MESSAGE_COUNT',
        fileConfig.worker?.summaryTriggerMessageCount,
        8
      ),
      summaryRefreshInterval: parseIntegerConfig(
        'WORKER_SUMMARY_REFRESH_INTERVAL',
        fileConfig.worker?.summaryRefreshInterval,
        4
      ),
      maxAttempts: parseIntegerConfig(
        'WORKER_MAX_ATTEMPTS',
        fileConfig.worker?.maxAttempts,
        4
      ),
      retryBaseMs: parseIntegerConfig(
        'WORKER_RETRY_BASE_MS',
        fileConfig.worker?.retryBaseMs,
        3000
      ),
      retryMaxDelayMs: parseIntegerConfig(
        'WORKER_RETRY_MAX_DELAY_MS',
        fileConfig.worker?.retryMaxDelayMs,
        300000
      ),
      imageInputEnabled: parseBooleanConfig(
        'WORKER_IMAGE_INPUT_ENABLED',
        undefined,
        true
      ),
      maxImagesPerMessage: parseIntegerConfig(
        'WORKER_MAX_IMAGES_PER_MESSAGE',
        fileConfig.worker?.maxImagesPerMessage,
        9
      )
    },
    maintenance: {
      backupKeepCount: parseIntegerConfig(
        'BACKUP_KEEP_COUNT',
        fileConfig.maintenance?.backupKeepCount,
        5
      ),
      rawEventRetentionDays: parseIntegerConfig(
        'RAW_EVENT_RETENTION_DAYS',
        fileConfig.maintenance?.rawEventRetentionDays,
        7
      ),
      deliveryRetentionDays: parseIntegerConfig(
        'DELIVERY_RETENTION_DAYS',
        fileConfig.maintenance?.deliveryRetentionDays,
        14
      ),
      jobRetentionDays: parseIntegerConfig(
        'JOB_RETENTION_DAYS',
        fileConfig.maintenance?.jobRetentionDays,
        30
      ),
      logRetentionDays: parseIntegerConfig(
        'LOG_RETENTION_DAYS',
        fileConfig.maintenance?.logRetentionDays,
        14
      )
    }
  };

  return config;
}

export function ensureRuntimeDirectories(config: AppConfig): void {
  mkdirSync(config.paths.configDir, { recursive: true });
  mkdirSync(config.paths.dataDir, { recursive: true });
  mkdirSync(config.paths.attachmentsDir, { recursive: true });
  mkdirSync(config.paths.imageAttachmentsDir, { recursive: true });
  mkdirSync(config.paths.backupsDir, { recursive: true });
  mkdirSync(config.paths.logsDir, { recursive: true });
  mkdirSync(config.paths.runDir, { recursive: true });
}

export function getConfigSummary(config: AppConfig): Record<string, unknown> {
  return {
    role: config.role,
    runtimeRoot: config.runtimeRoot,
    configFiles: config.configFiles,
    dbFile: config.paths.dbFile,
    attachmentsDir: config.paths.attachmentsDir,
    backupsDir: config.paths.backupsDir,
    logFile: config.paths.logFile,
    healthFile: config.paths.healthFile,
    feishu: {
      appId: redact(config.feishu.appId),
      appSecret: redact(config.feishu.appSecret),
      verificationToken: config.feishu.verificationToken ? '***' : null,
      encryptKey: config.feishu.encryptKey ? '***' : null,
      botOpenId: config.feishu.botOpenId ?? null,
      connectionMode: config.feishu.connectionMode,
      domain: config.feishu.domain,
      bindHost: config.feishu.bindHost,
      bindPort: config.feishu.bindPort,
      callbackPath: config.feishu.callbackPath,
      publicBaseUrl: config.feishu.publicBaseUrl ?? null
    },
    triggerPolicy: config.triggerPolicy,
    openai: {
      apiKey: config.openai.apiKey ? redact(config.openai.apiKey) : null,
      model: config.openai.model,
      baseUrl: config.openai.baseUrl ?? null
    },
    codex: config.codex,
    worker: config.worker,
    maintenance: config.maintenance
  };
}

function loadEnvFiles(workspaceRoot: string): void {
  const envFiles = ['.env', '.env.local'];
  for (const envFile of envFiles) {
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
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      if (!key || process.env[key] !== undefined) {
        continue;
      }

      process.env[key] = stripQuotes(rawValue);
    }
  }
}

function loadFileConfigOverrides(
  defaultFile: string,
  localFile: string
): FileConfigOverrides {
  const merged: FileConfigOverrides = {};

  for (const source of [defaultFile, localFile]) {
    if (!existsSync(source)) {
      continue;
    }

    const parsed = JSON.parse(readFileSync(source, 'utf8')) as FileConfigOverrides;
    mergeInto(merged, parsed);
  }

  return merged;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseIntegerEnv(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be an integer, received "${value}".`);
  }

  return parsed;
}

function parseIntegerConfig(
  envName: string,
  fileValue: number | undefined,
  fallback: number
): number {
  const envValue = optionalEnv(envName);
  if (envValue) {
    return parseIntegerEnv(envName, fallback);
  }

  if (typeof fileValue === 'number' && Number.isFinite(fileValue)) {
    return fileValue;
  }

  return fallback;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name);
  if (!value) {
    return fallback;
  }

  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0') {
    return false;
  }

  throw new Error(`${name} must be a boolean, received "${value}".`);
}

function parseBooleanConfig(
  envName: string,
  fileValue: boolean | undefined,
  fallback: boolean
): boolean {
  const envValue = optionalEnv(envName);
  if (envValue) {
    return parseBooleanEnv(envName, fallback);
  }

  if (typeof fileValue === 'boolean') {
    return fileValue;
  }

  return fallback;
}

function parseCsvEnv(name: string): string[] {
  const value = optionalEnv(name);
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCsvConfig(
  envName: string,
  fileValue: string[] | undefined
): string[] {
  const envValue = optionalEnv(envName);
  if (envValue) {
    return parseCsvEnv(envName);
  }

  if (Array.isArray(fileValue)) {
    return fileValue.map((item) => String(item).trim()).filter(Boolean);
  }

  return [];
}

function mergeInto<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const existing = target[key] as Record<string, unknown> | undefined;
      const next =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? existing
          : {};
      mergeInto(next, value as Record<string, unknown>);
      (target as Record<string, unknown>)[key] = next;
      continue;
    }

    (target as Record<string, unknown>)[key] = value;
  }
}

function redact(value: string): string {
  if (value.length <= 8) {
    return '***';
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
