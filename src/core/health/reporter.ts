import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { nowIso } from '../utils/time.js';

export class HealthReporter {
  public constructor(
    private readonly service: string,
    private readonly filePath: string
  ) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }

  public update(payload: Record<string, unknown>): void {
    const content = {
      service: this.service,
      pid: process.pid,
      version: process.env.npm_package_version ?? '0.1.0',
      updatedAt: nowIso(),
      ...payload
    };

    writeFileSync(this.filePath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  }
}

