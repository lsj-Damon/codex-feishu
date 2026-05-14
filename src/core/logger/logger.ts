import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import util from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class AppLogger {
  public constructor(
    private readonly component: string,
    private readonly logFilePath: string,
    private readonly baseContext: Record<string, unknown> = {}
  ) {
    mkdirSync(path.dirname(logFilePath), { recursive: true });
  }

  public child(context: Record<string, unknown>): AppLogger {
    return new AppLogger(this.component, this.logFilePath, {
      ...this.baseContext,
      ...context
    });
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  private write(
    level: LogLevel,
    message: string,
    context: Record<string, unknown> = {}
  ): void {
    const mergedContext = {
      ...this.baseContext,
      ...context
    };
    const entry = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...compactContext(mergedContext)
    };

    appendFileSync(this.logFilePath, `${JSON.stringify(entry)}\n`, 'utf8');

    const printableContext =
      Object.keys(mergedContext).length > 0
        ? ` ${util.inspect(mergedContext, {
            depth: 4,
            breakLength: 120,
            compact: true
          })}`
        : '';
    const line = `[${entry.ts}] [${level.toUpperCase()}] [${this.component}] ${message}${printableContext}`;

    if (level === 'error') {
      safeConsoleWrite('error', line);
      return;
    }

    if (level === 'warn') {
      safeConsoleWrite('warn', line);
      return;
    }

    safeConsoleWrite('log', line);
  }
}

function compactContext(
  context: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined)
  );
}

function safeConsoleWrite(
  method: 'log' | 'warn' | 'error',
  line: string
): void {
  try {
    console[method](line);
  } catch {
    // Detached/background Windows runtimes can lose stdio pipes.
    // File logging already succeeded, so console failure is non-fatal.
  }
}
