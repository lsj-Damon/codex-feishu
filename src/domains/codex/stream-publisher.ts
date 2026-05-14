import type { CodexSessionManager } from './session-manager.js';
import { CodexProgressBuffer } from './progress-buffer.js';
import { translateCodexEvent } from './event-translator.js';
import type {
  CodexRawEvent,
  CodexRunCompletion,
  CodexRunHandle
} from './types.js';

export interface CodexProgressSink {
  sendProgress(text: string): Promise<string | null>;
  sendFinal(text: string): Promise<string | null>;
}

export async function consumeCodexRunStream(input: {
  handle: CodexRunHandle;
  runId: number;
  sessionManager: CodexSessionManager;
  sink: CodexProgressSink;
  progressIntervalMs: number;
  onWarning?: (message: string) => void;
}): Promise<CodexRunCompletion> {
  const progressBuffer = new CodexProgressBuffer(input.progressIntervalMs);
  let sequenceNo = 1;
  let lastFinalText: string | null = null;

  for await (const event of input.handle.stream) {
    const record = input.sessionManager.appendStreamEvent({
      runId: input.runId,
      sequenceNo,
      eventType: event.type,
      payloadJson: JSON.stringify(event)
    });
    sequenceNo += 1;

    const translated = translateCodexEvent(event);
    for (const item of translated) {
      if (item.kind === 'progress') {
        if (progressBuffer.shouldEmit(item.text)) {
          try {
            const feishuMessageId = await input.sink.sendProgress(item.text);
            input.sessionManager.markStreamEventPushed(record.id, feishuMessageId);
          } catch (error) {
            input.onWarning?.(
              `progress delivery failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
        continue;
      }

      lastFinalText = item.text;
    }
  }

  const completion = await input.handle.waitForCompletion();
  const finalText =
    completion.finalMessageText ?? lastFinalText ?? 'Codex execution completed.';
  try {
    await input.sink.sendFinal(finalText);
  } catch (error) {
    input.onWarning?.(
      `final stream delivery failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return {
    ...completion,
    finalMessageText: finalText
  };
}

export function createProgressMessageEvent(text: string): CodexRawEvent {
  return {
    type: 'progress.message',
    text
  };
}
