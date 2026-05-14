import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AppLogger } from '../logger/logger.js';

export function openDatabase(
  dbFilePath: string,
  logger: AppLogger
): DatabaseSync {
  mkdirSync(path.dirname(dbFilePath), { recursive: true });

  const database = new DatabaseSync(dbFilePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  logger.info('sqlite database opened', { dbFilePath });
  return database;
}

export function executeInTransaction<T>(
  database: DatabaseSync,
  fn: () => T
): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

