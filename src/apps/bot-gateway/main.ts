import path from 'node:path';

import { ensureRuntimeDirectories, getConfigSummary, loadAppConfig } from '../../core/config/index.js';
import { openDatabase } from '../../core/db/database.js';
import { runMigrations } from '../../core/db/migrations.js';
import { HealthReporter } from '../../core/health/reporter.js';
import { AppLogger } from '../../core/logger/logger.js';
import { acquireSingleInstance } from '../../core/runtime/single-instance.js';
import { FeishuLongConnection } from '../../domains/feishu/long-connection.js';
import { BotGatewayService } from './service.js';

async function main(): Promise<void> {
  installStdIoGuards();
  const config = loadAppConfig('gateway');
  ensureRuntimeDirectories(config);

  const logger = new AppLogger('gateway', config.paths.logFile);
  const instanceLock = acquireSingleInstance(
    path.join(config.paths.runDir, 'gateway.lock'),
    logger
  );
  logger.info('starting gateway', {
    config: getConfigSummary(config)
  });

  const database = openDatabase(config.paths.dbFile, logger);
  const migrationStatus = runMigrations(
    database,
    path.join(config.workspaceRoot, 'migrations'),
    logger
  );
  logger.info('migration status ready', {
    currentVersion: migrationStatus.currentVersion,
    applied: migrationStatus.applied
  });

  const service = new BotGatewayService(
    config,
    database,
    logger,
    new FeishuLongConnection(config, logger),
    new HealthReporter('gateway', config.paths.healthFile)
  );

  installShutdownHandlers(async () => {
    await service.stop();
    database.close();
    instanceLock.release();
    logger.info('gateway stopped');
  }, logger);

  await service.start();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function installShutdownHandlers(
  shutdown: () => Promise<void>,
  logger: AppLogger
): void {
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('gateway shutdown requested');
    await shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void stop();
  });
  process.on('SIGTERM', () => {
    void stop();
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    void stop();
  });
  process.on('unhandledRejection', (error) => {
    logger.error('unhandled rejection', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
  });
}

function installStdIoGuards(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error?.code === 'EPIPE') {
        return;
      }
      throw error;
    });
  }
}
