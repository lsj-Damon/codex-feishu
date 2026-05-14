import { openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type { AppLogger } from '../logger/logger.js';

export interface InstanceLock {
  release: () => void;
  lockFile: string;
}

export function acquireSingleInstance(
  lockFile: string,
  logger: AppLogger
): InstanceLock {
  try {
    const fd = openSync(lockFile, 'wx');
    writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString()
      }),
      'utf8'
    );
    return {
      lockFile,
      release: () => {
        try {
          rmSync(lockFile, { force: true });
          logger.info('released single-instance lock', { lockFile });
        } catch {
          // ignore
        }
      }
    };
  } catch {
    const stalePid = readLockPid(lockFile);
    if (stalePid && isProcessAlive(stalePid)) {
      throw new Error(
        `Another instance is already running (pid=${stalePid}) for lock ${lockFile}.`
      );
    }

    rmSync(lockFile, { force: true });
    logger.warn('removed stale single-instance lock', {
      lockFile,
      stalePid: stalePid ?? null
    });
    return acquireSingleInstance(lockFile, logger);
  }
}

function readLockPid(lockFile: string): number | null {
  try {
    const content = readFileSync(lockFile, 'utf8');
    const parsed = JSON.parse(content) as { pid?: number };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
