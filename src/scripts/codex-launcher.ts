import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

type Mode = 'new' | 'resume';

interface LauncherArgs {
  cliPath: string;
  workspaceRoot: string;
  mode: Mode;
  sessionId?: string;
  promptFile: string;
  imagePaths: string[];
}

function main(): void {
  installStdIoGuards();
  const args = parseArgs(process.argv.slice(2));
  const promptText = readFileSync(args.promptFile, 'utf8');
  const spawnSpec = buildSpawnSpec(args);

  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: args.workspaceRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false
  });

  child.stdout.on('data', (chunk) => {
    safeWriteStdout(chunk);
  });
  child.stderr.on('data', (chunk) => {
    safeWriteStderr(chunk);
  });
  child.stdout.on('error', (error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'EPIPE') {
      return;
    }
  });
  child.stderr.on('error', (error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'EPIPE') {
      return;
    }
  });
  child.stdin.on('error', (error) => {
    if ((error as NodeJS.ErrnoException)?.code === 'EPIPE') {
      return;
    }
  });
  child.on('error', (error) => {
    safeWriteStderr(`${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });

  child.stdin.write(promptText, 'utf8');
  child.stdin.end();
}

function installStdIoGuards(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error?.code === 'EPIPE') {
        return;
      }
    });
  }
}

function safeWriteStdout(chunk: string | Buffer): void {
  try {
    process.stdout.write(chunk);
  } catch {
    // If the parent pipe is gone, avoid crashing the launcher.
  }
}

function safeWriteStderr(chunk: string | Buffer): void {
  try {
    process.stderr.write(chunk);
  } catch {
    // If the parent pipe is gone, avoid crashing the launcher.
  }
}

function parseArgs(argv: string[]): LauncherArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      continue;
    }
    map.set(key.slice(2), value);
  }

  const cliPath = map.get('cliPath');
  const workspaceRoot = map.get('workspaceRoot');
  const mode = map.get('mode') as Mode | undefined;
  const promptFile = map.get('promptFile');
  const sessionId = map.get('sessionId');
  const imagePaths: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const imagePath = argv[i + 1];
    if (argv[i] === '--imagePath' && imagePath) {
      imagePaths.push(imagePath);
      i += 1;
    }
  }

  if (!cliPath || !workspaceRoot || !mode || !promptFile) {
    throw new Error('Missing required launcher args.');
  }
  if (mode === 'resume' && !sessionId) {
    throw new Error('Resume mode requires sessionId.');
  }

  return {
    cliPath,
    workspaceRoot,
    mode,
    sessionId,
    promptFile,
    imagePaths
  };
}

function buildSpawnSpec(args: LauncherArgs): { command: string; args: string[] } {
  const imageArgs = args.imagePaths.flatMap((imagePath) => ['-i', imagePath]);
  const codexArgs =
    args.mode === 'resume'
      ? [
          'exec',
          'resume',
          args.sessionId!,
          ...imageArgs,
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
          '-'
        ]
      : [
          'exec',
          '--cd',
          args.workspaceRoot,
          ...imageArgs,
          '--dangerously-bypass-approvals-and-sandbox',
          '--json',
          '-'
        ];

  const lower = args.cliPath.toLowerCase();
  if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    return {
      command:
        process.env.ComSpec ||
        `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\cmd.exe`,
      args: ['/d', '/s', '/c', args.cliPath, ...codexArgs]
    };
  }

  if (process.platform === 'win32' && lower.endsWith('.ps1')) {
    return {
      command: 'powershell.exe',
      args: ['-ExecutionPolicy', 'Bypass', '-File', args.cliPath, ...codexArgs]
    };
  }

  return {
    command: args.cliPath,
    args: codexArgs
  };
}

main();
