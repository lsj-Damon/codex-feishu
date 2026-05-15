import path from 'node:path';

import type {
  CodexCliClient,
  CodexRawEvent,
  CodexResumeInput,
  CodexRunCompletion,
  CodexRunHandle,
  CodexRunInput
} from './types.js';
import { createProgressMessageEvent } from './stream-publisher.js';

interface FakeCodexScript {
  sessionId: string;
  events: CodexRawEvent[];
  completion: Omit<CodexRunCompletion, 'codexSessionId'>;
  waitForCompletionError?: Error;
}

export class FakeCodexCliClient implements CodexCliClient {
  private scriptCounter = 0;

  public constructor(private readonly scripts: FakeCodexScript[] = []) {}

  public async runNewSession(input: CodexRunInput): Promise<CodexRunHandle> {
    return this.createHandle(
      this.nextScript(input.outputDir, `fake-thread-${this.scriptCounter + 1}`)
    );
  }

  public async resumeSession(input: CodexResumeInput): Promise<CodexRunHandle> {
    return this.createHandle(
      this.nextScript(input.outputDir, input.codexSessionId)
    );
  }

  private nextScript(outputDir: string, sessionId: string): FakeCodexScript {
    const scripted = this.scripts[this.scriptCounter++];
    if (scripted) {
      return scripted;
    }

    return {
      sessionId,
      events: [
        { type: 'thread.started', thread_id: sessionId },
        { type: 'turn.started' },
        createProgressMessageEvent('正在读取项目结构'),
        createProgressMessageEvent('正在检查关键文件'),
        {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text: '已完成分析，未发现需要立即修改的内容。'
          }
        },
        {
          type: 'turn.completed',
          usage: {
            input_tokens: 10,
            output_tokens: 20
          }
        }
      ],
      completion: {
        exitCode: 0,
        finalMessageText: '已完成分析，未发现需要立即修改的内容。',
        jsonlPath: path.join(outputDir, 'fake-run.jsonl'),
        stderrPath: path.join(outputDir, 'fake-run.stderr')
      }
    };
  }

  private createHandle(script: FakeCodexScript): CodexRunHandle {
    const completion: CodexRunCompletion = {
      ...script.completion,
      codexSessionId: script.sessionId
    };

    return {
      stream: createAsyncEventStream(script.events),
      waitForCompletion: async () => {
        if (script.waitForCompletionError) {
          throw script.waitForCompletionError;
        }
        return completion;
      },
      cancel: async () => undefined
    };
  }
}

async function* createAsyncEventStream(events: CodexRawEvent[]) {
  for (const event of events) {
    yield event;
  }
}
