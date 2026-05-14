import path from 'node:path';

import { ensureRuntimeDirectories, loadAppConfig } from '../core/config/index.js';
import { openDatabase } from '../core/db/database.js';
import { runMigrations } from '../core/db/migrations.js';
import { AppLogger } from '../core/logger/logger.js';

function main(): void {
  const config = loadAppConfig('gateway');
  ensureRuntimeDirectories(config);

  const logger = new AppLogger(
    'migrate',
    path.join(config.paths.logsDir, 'migrate.log')
  );
  const database = openDatabase(config.paths.dbFile, logger);

  runMigrations(database, path.join(config.workspaceRoot, 'migrations'), logger);
  database.close();

  logger.info('migrations complete');
}

main();
