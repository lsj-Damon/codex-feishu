import path from 'node:path';

import { ensureRuntimeDirectories, getConfigSummary, loadAppConfig } from '../../core/config/index.js';
import { openDatabase } from '../../core/db/database.js';
import { runMigrations } from '../../core/db/migrations.js';
import { HealthReporter } from '../../core/health/reporter.js';
import { AppLogger } from '../../core/logger/logger.js';
import { acquireSingleInstance } from '../../core/runtime/single-instance.js';
import { FeishuMessageClient } from '../../domains/feishu/client.js';
import { AssistantWorkerService } from './service.js';

async function main(): Promise<void> {
  installStdIoGuards();
  const config = loadAppConfig('worker');
  ensureRuntimeDirectories(config);

  const logger = new AppLogger('worker', config.paths.logFile);
  const instanceLock = acquireSingleInstance(
    path.join(config.paths.runDir, 'worker.lock'),
    logger
  );
  logger.info('starting worker', {
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

  const service = new AssistantWorkerService(
    config,
    database,
    logger,
    new FeishuMessageClient(config, logger),
    null,
    new HealthReporter('worker', config.paths.healthFile)
  );

  installShutdownHandlers(() => {
    service.stop();
    database.close();
    instanceLock.release();
    logger.info('worker stopped');
  }, logger);

  await service.start();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function installShutdownHandlers(shutdown: () => void, logger: AppLogger): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('worker shutdown requested');
    shutdown();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    stop();
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
