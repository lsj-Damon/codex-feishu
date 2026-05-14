import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadAppConfig } from '../core/config/index.js';
import { openDatabase } from '../core/db/database.js';
import { getMigrationStatus, runMigrations } from '../core/db/migrations.js';
import { AppLogger } from '../core/logger/logger.js';
import { acquireSingleInstance } from '../core/runtime/single-instance.js';

function main(): void {
  testConfigOverlay();
  testMigrationStatus();
  testSingleInstanceLock();
  console.log('M4 smoke checks passed.');
}

function testConfigOverlay(): void {
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'feishu-m4-config-'));
  const runtimeRoot = path.join(workspaceRoot, '.runtime');
  mkdirSync(path.join(workspaceRoot, 'config'), { recursive: true });
  writeFileSync(
    path.join(workspaceRoot, '.env'),
    [
      'FEISHU_APP_ID=cli_test',
      'FEISHU_APP_SECRET=secret_test',
      'OPENAI_API_KEY=sk-test',
      `RUNTIME_ROOT=${runtimeRoot}`
    ].join('\n')
  );
  writeFileSync(
    path.join(workspaceRoot, 'config', 'default.json'),
    JSON.stringify(
      {
        openai: { model: 'gpt-5.4' },
        worker: { maxReplyChars: 777 },
        maintenance: { backupKeepCount: 9 }
      },
      null,
      2
    )
  );

  const previousCwd = process.cwd();
  process.chdir(workspaceRoot);
  try {
    const config = loadAppConfig('worker');
    assert.equal(config.openai.model, 'gpt-5.4');
    assert.equal(config.worker.maxReplyChars, 777);
    assert.equal(config.maintenance.backupKeepCount, 9);
    assert.equal(config.configFiles.defaultFile, path.join(workspaceRoot, 'config', 'default.json'));
  } finally {
    process.chdir(previousCwd);
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function testMigrationStatus(): void {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'feishu-m4-migration-'));
  const logger = new AppLogger('m4-smoke', path.join(runtimeRoot, 'migration.log'));
  const database = openDatabase(path.join(runtimeRoot, 'app.db'), logger);
  const status = runMigrations(
    database,
    path.join(process.cwd(), 'migrations'),
    logger
  );
  const latest = getMigrationStatus(database);
  assert.equal(status.currentVersion, latest.currentVersion);
  assert.equal(latest.currentVersion, '0002_reliability.sql');
  database.close();
  rmSync(runtimeRoot, { recursive: true, force: true });
}

function testSingleInstanceLock(): void {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'feishu-m4-lock-'));
  const logger = new AppLogger('m4-smoke', path.join(runtimeRoot, 'lock.log'));
  const lockFile = path.join(runtimeRoot, 'gateway.lock');

  const first = acquireSingleInstance(lockFile, logger);
  let threw = false;
  try {
    acquireSingleInstance(lockFile, logger);
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  first.release();

  const second = acquireSingleInstance(lockFile, logger);
  second.release();
  rmSync(runtimeRoot, { recursive: true, force: true });
}

main();
