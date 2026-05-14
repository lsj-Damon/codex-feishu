import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { RealCodexCliClient } from '../domains/codex/client.js';

async function main(): Promise<void> {
  const runtimeRoot = path.join(process.cwd(), '.runtime', 'codex-real-smoke');
  rmSync(runtimeRoot, { recursive: true, force: true });
  mkdirSync(runtimeRoot, { recursive: true });

  const client = new RealCodexCliClient(
    'E:\\AppInstall\\nodejs\\node_global\\codex.cmd'
  );
  const handle = await client.runNewSession({
    workspaceRoot: process.cwd(),
    outputDir: runtimeRoot,
    timeoutMs: 60000,
    promptText: [
      'You are testing Codex multiline prompt handling.',
      '',
      'Reply with exactly OK.',
      'Do not use any tools.'
    ].join('\n')
  });

  const events: Array<{ type: string }> = [];
  for await (const event of handle.stream) {
    events.push({ type: event.type });
  }

  const completion = await handle.waitForCompletion();
  assert.equal(events.length > 0, true);
  assert.equal(
    events.some((event) => event.type === 'thread.started'),
    true
  );
  assert.equal(
    events.some((event) => event.type === 'item.completed'),
    true
  );
  assert.equal(typeof completion.codexSessionId === 'string', true);
  assert.equal((completion.finalMessageText ?? '').trim(), 'OK');

  console.log('Codex real smoke checks passed.');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
