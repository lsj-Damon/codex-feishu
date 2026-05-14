import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type CleanupConfig = {
  runtimeRoot: string;
  rawEventRetentionDays: number;
  deliveryRetentionDays: number;
  jobRetentionDays: number;
  logRetentionDays: number;
};

function main(): void {
  const workspaceRoot = process.cwd();
  loadEnvFiles(workspaceRoot);
  const cliArgs = parseArgs(process.argv.slice(2));
  const runtimeRoot = cliArgs.runtimeRoot ?? resolveRuntimeRoot(workspaceRoot);
  const fileConfig = loadMaintenanceConfig(
    path.join(workspaceRoot, 'config', 'default.json'),
    path.join(runtimeRoot, 'config', 'local.json')
  );
  const config: CleanupConfig = {
    runtimeRoot,
    rawEventRetentionDays: readIntEnv(
      'RAW_EVENT_RETENTION_DAYS',
      fileConfig.rawEventRetentionDays ?? 7
    ),
    deliveryRetentionDays: readIntEnv(
      'DELIVERY_RETENTION_DAYS',
      fileConfig.deliveryRetentionDays ?? 14
    ),
    jobRetentionDays: readIntEnv(
      'JOB_RETENTION_DAYS',
      fileConfig.jobRetentionDays ?? 30
    ),
    logRetentionDays: readIntEnv(
      'LOG_RETENTION_DAYS',
      fileConfig.logRetentionDays ?? 14
    )
  };

  const dbFile = path.join(config.runtimeRoot, 'data', 'app.db');
  if (!existsSync(dbFile)) {
    console.log(JSON.stringify({ cleaned: false, reason: 'db_missing', dbFile }));
    return;
  }

  const database = new DatabaseSync(dbFile);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  const summary = {
    rawEventsDeleted: tableExists(database, 'raw_events')
      ? deleteByAge(
          database,
          'raw_events',
          'received_at',
          config.rawEventRetentionDays
        )
      : 0,
    deliveriesDeleted: tableExists(database, 'deliveries')
      ? deleteTerminalDeliveries(database, config.deliveryRetentionDays)
      : 0,
    jobsDeleted: tableExists(database, 'jobs')
      ? deleteTerminalJobs(database, config.jobRetentionDays)
      : 0,
    logsDeleted: cleanupLogs(config.runtimeRoot, config.logRetentionDays)
  };

  database.close();
  console.log(JSON.stringify(summary));
}

function parseArgs(argv: string[]): { runtimeRoot?: string } {
  const result: { runtimeRoot?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtime-root') {
      result.runtimeRoot = argv[index + 1];
      index += 1;
    }
  }
  return result;
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

function resolveRuntimeRoot(workspaceRoot: string): string {
  const explicit = process.env.RUNTIME_ROOT?.trim();
  if (explicit) {
    return explicit;
  }

  const localAppData = process.env.LOCALAPPDATA;
  return localAppData
    ? path.join(localAppData, 'FeishuCodexBot')
    : path.join(workspaceRoot, '.runtime', 'FeishuCodexBot');
}

function loadMaintenanceConfig(defaultFile: string, localFile: string): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const source of [defaultFile, localFile]) {
    if (!existsSync(source)) {
      continue;
    }
    const parsed = JSON.parse(readFileSync(source, 'utf8')) as {
      maintenance?: Record<string, number>;
    };
    if (parsed.maintenance) {
      Object.assign(merged, parsed.maintenance);
    }
  }
  return merged;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function deleteByAge(
  database: DatabaseSync,
  table: string,
  column: string,
  retentionDays: number
): number {
  const cutoff = cutoffIso(retentionDays);
  const result = database
    .prepare(`DELETE FROM ${table} WHERE ${column} < ?`)
    .run(cutoff);
  return Number(result.changes ?? 0);
}

function tableExists(database: DatabaseSync, table: string): boolean {
  const row = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function deleteTerminalDeliveries(database: DatabaseSync, retentionDays: number): number {
  const cutoff = cutoffIso(retentionDays);
  const result = database
    .prepare(`
      DELETE FROM deliveries
      WHERE updated_at < ?
        AND status IN ('succeeded', 'failed')
    `)
    .run(cutoff);
  return Number(result.changes ?? 0);
}

function deleteTerminalJobs(database: DatabaseSync, retentionDays: number): number {
  const cutoff = cutoffIso(retentionDays);
  const result = database
    .prepare(`
      DELETE FROM jobs
      WHERE updated_at < ?
        AND status IN ('succeeded', 'failed', 'cancelled')
    `)
    .run(cutoff);
  return Number(result.changes ?? 0);
}

function cleanupLogs(runtimeRoot: string, retentionDays: number): number {
  const logsDir = path.join(runtimeRoot, 'logs');
  if (!existsSync(logsDir)) {
    return 0;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const file of readdirSync(logsDir)) {
    const fullPath = path.join(logsDir, file);
    try {
      const modified = statSync(fullPath).mtimeMs;
      if (modified < cutoff) {
        rmSync(fullPath, { force: true });
        deleted += 1;
      }
    } catch {
      // ignore
    }
  }
  return deleted;
}

function cutoffIso(retentionDays: number): string {
  return new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

main();
