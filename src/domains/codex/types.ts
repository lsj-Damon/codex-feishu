export interface CodexRunInput {
  workspaceRoot: string;
  promptText: string;
  outputDir: string;
  timeoutMs: number;
}

export interface CodexResumeInput extends CodexRunInput {
  codexSessionId: string;
}

export interface CodexRawEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexRunCompletion {
  exitCode: number | null;
  finalMessageText: string | null;
  codexSessionId: string | null;
  jsonlPath: string | null;
  stderrPath: string | null;
}

export interface CodexRunHandle {
  stream: AsyncIterable<CodexRawEvent>;
  waitForCompletion(): Promise<CodexRunCompletion>;
  cancel(): Promise<void>;
}

export interface CodexCliClient {
  runNewSession(input: CodexRunInput): Promise<CodexRunHandle>;
  resumeSession(input: CodexResumeInput): Promise<CodexRunHandle>;
}

export interface CodexTranslatedEvent {
  kind: 'progress' | 'final';
  text: string;
  eventType: string;
}
