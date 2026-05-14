import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  CodexCliClient,
  CodexRawEvent,
  CodexResumeInput,
  CodexRunCompletion,
  CodexRunHandle,
  CodexRunInput
} from './types.js';

export class RealCodexCliClient implements CodexCliClient {
  public constructor(private readonly cliPath = 'codex') {}

  public async runNewSession(input: CodexRunInput): Promise<CodexRunHandle> {
    return createCodexRunHandle(
      buildLauncherArgs({
        cliPath: this.cliPath,
        workspaceRoot: input.workspaceRoot,
        mode: 'new',
        promptFile: writePromptFile(input.outputDir, input.promptText)
      }),
      input.outputDir
    );
  }

  public async resumeSession(input: CodexResumeInput): Promise<CodexRunHandle> {
    return createCodexRunHandle(
      buildLauncherArgs({
        cliPath: this.cliPath,
        workspaceRoot: input.workspaceRoot,
        mode: 'resume',
        sessionId: input.codexSessionId,
        promptFile: writePromptFile(input.outputDir, input.promptText)
      }),
      input.outputDir
    );
  }
}

function createCodexRunHandle(
  args: string[],
  outputDir: string
): CodexRunHandle {
  mkdirSync(outputDir, { recursive: true });
  const jsonlPath = path.join(outputDir, 'codex-run.jsonl');
  const stderrPath = path.join(outputDir, 'codex-run.stderr.log');
  writeFileSync(jsonlPath, '', 'utf8');
  writeFileSync(stderrPath, '', 'utf8');

  const launcherPath = path.join(process.cwd(), 'dist', 'scripts', 'codex-launcher.js');
  const child = spawn(process.execPath, [launcherPath, ...args], {
    cwd: outputDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });

  let finalMessageText: string | null = null;
  let threadId: string | null = null;
  const queue: CodexRawEvent[] = [];
  const waiters: Array<(value: IteratorResult<CodexRawEvent>) => void> = [];
  let streamDone = false;
  let exitCode: number | null = null;
  let completionResolved = false;
  let resolveCompletion!: (value: CodexRunCompletion) => void;
  const completionPromise = new Promise<CodexRunCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  const pushEvent = (event: CodexRawEvent): void => {
    writeFileSync(jsonlPath, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      flag: 'a'
    });
    if (waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter({ value: event, done: false });
      return;
    }
    queue.push(event);
  };

  const finalizeCompletion = (): void => {
    if (completionResolved || exitCode === null) {
      return;
    }
    completionResolved = true;
    resolveCompletion({
      exitCode,
      finalMessageText,
      codexSessionId: threadId,
      jsonlPath,
      stderrPath
    });
  };

  const markStreamDone = (): void => {
    if (streamDone) {
      return;
    }
    streamDone = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      waiter({ value: undefined, done: true });
    }
    finalizeCompletion();
  };

  const stdoutRl = createInterface({ input: child.stdout });
  stdoutRl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed) as CodexRawEvent & {
        thread_id?: string;
        item?: { type?: string; text?: string };
      };
      if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
        threadId = parsed.thread_id;
      }
      if (
        parsed.type === 'item.completed' &&
        parsed.item?.type === 'agent_message' &&
        typeof parsed.item.text === 'string'
      ) {
        finalMessageText = parsed.item.text;
      }
      pushEvent(parsed);
    } catch {
      // Ignore non-JSON noise in stdout.
    }
  });
  stdoutRl.on('close', () => {
    markStreamDone();
  });
  stdoutRl.on('error', (error) => {
    writeFileSync(stderrPath, `stdout-readline:${error.message}\n`, {
      encoding: 'utf8',
      flag: 'a'
    });
    markStreamDone();
  });

  const stderrRl = createInterface({ input: child.stderr });
  stderrRl.on('line', (line) => {
    writeFileSync(stderrPath, `${line}\n`, {
      encoding: 'utf8',
      flag: 'a'
    });
  });
  stderrRl.on('error', (error) => {
    writeFileSync(stderrPath, `stderr-readline:${error.message}\n`, {
      encoding: 'utf8',
      flag: 'a'
    });
  });

  child.stdout.on('error', (error) => {
    writeFileSync(stderrPath, `stdout-stream:${error.message}\n`, {
      encoding: 'utf8',
      flag: 'a'
    });
    markStreamDone();
  });
  child.stderr.on('error', (error) => {
    writeFileSync(stderrPath, `stderr-stream:${error.message}\n`, {
      encoding: 'utf8',
      flag: 'a'
    });
  });

  child.on('exit', (code) => {
    exitCode = code;
    finalizeCompletion();
    markStreamDone();
  });

  child.on('error', (error) => {
    writeFileSync(stderrPath, `${error.message}\n`, {
      encoding: 'utf8',
      flag: 'a'
    });
    exitCode = 1;
    markStreamDone();
  });

  return {
    stream: createAsyncIterable(queue, waiters, () => streamDone),
    waitForCompletion: async () => completionPromise,
    cancel: async () => {
      if (!child.killed) {
        child.kill();
      }
    }
  };
}

function writePromptFile(outputDir: string, promptText: string): string {
  mkdirSync(outputDir, { recursive: true });
  const promptFile = path.join(outputDir, 'prompt.txt');
  writeFileSync(promptFile, promptText, 'utf8');
  return promptFile;
}

function buildLauncherArgs(input: {
  cliPath: string;
  workspaceRoot: string;
  mode: 'new' | 'resume';
  promptFile: string;
  sessionId?: string;
}): string[] {
  const args = [
    '--cliPath',
    input.cliPath,
    '--workspaceRoot',
    input.workspaceRoot,
    '--mode',
    input.mode,
    '--promptFile',
    input.promptFile
  ];

  if (input.sessionId) {
    args.push('--sessionId', input.sessionId);
  }

  return args;
}

function createAsyncIterable(
  queue: CodexRawEvent[],
  waiters: Array<(value: IteratorResult<CodexRawEvent>) => void>,
  isDone: () => boolean
): AsyncIterable<CodexRawEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<CodexRawEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({
              value: queue.shift()!,
              done: false
            });
          }

          if (isDone()) {
            return Promise.resolve({
              value: undefined,
              done: true
            });
          }

          return new Promise<IteratorResult<CodexRawEvent>>((resolve) => {
            waiters.push(resolve);
          });
        }
      };
    }
  };
}
