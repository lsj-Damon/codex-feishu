import type { CodexRawEvent, CodexTranslatedEvent } from './types.js';

export function translateCodexEvent(event: CodexRawEvent): CodexTranslatedEvent[] {
  if (event.type === 'thread.started') {
    return [
      {
        kind: 'progress',
        text: '已创建 Codex 会话，准备开始处理。',
        eventType: event.type
      }
    ];
  }

  if (event.type === 'turn.started') {
    return [
      {
        kind: 'progress',
        text: 'Codex 已开始处理当前请求。',
        eventType: event.type
      }
    ];
  }

  if (event.type === 'progress.message' && typeof event.text === 'string') {
    return [
      {
        kind: 'progress',
        text: event.text,
        eventType: event.type
      }
    ];
  }

  if (event.type === 'item.completed') {
    const item = event.item as
      | { type?: string; text?: string }
      | undefined;
    if (item?.type === 'agent_message' && typeof item.text === 'string') {
      return [
        {
          kind: 'final',
          text: item.text,
          eventType: event.type
        }
      ];
    }

    if (item?.type === 'tool_call' && typeof item.text === 'string') {
      return [
        {
          kind: 'progress',
          text: item.text,
          eventType: event.type
        }
      ];
    }
  }

  return [];
}
