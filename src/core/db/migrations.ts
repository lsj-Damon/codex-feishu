import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { AppLogger } from '../logger/logger.js';

export interface MigrationStatus {
  currentVersion: string | null;
  applied: string[];
}

export function runMigrations(
  database: DatabaseSync,
  migrationsDir: string,
  logger: AppLogger
): MigrationStatus {
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  if (!existsSync(migrationsDir)) {
    logger.warn('migrations directory does not exist', { migrationsDir });
    return getMigrationStatus(database);
  }

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  const appliedRows = database
    .prepare('SELECT name FROM _migrations ORDER BY name ASC')
    .all() as Array<{ name: string }>;
  const applied = new Set(appliedRows.map((row) => row.name));

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const migrationPath = path.join(migrationsDir, file);
    const sql = readFileSync(migrationPath, 'utf8');

    logger.info('applying migration', { file });
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(sql);
      database
        .prepare(
          'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)'
        )
        .run(file, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  return getMigrationStatus(database);
}

export function getMigrationStatus(database: DatabaseSync): MigrationStatus {
  const rows = database
    .prepare('SELECT name FROM _migrations ORDER BY name ASC')
    .all() as Array<{ name: string }>;

  return {
    currentVersion: rows.length > 0 ? rows[rows.length - 1]?.name ?? null : null,
    applied: rows.map((row) => row.name)
  };
}
