import type { MessageRecord } from '../../core/types/domain.js';

export function buildOpenAiContext(messages: MessageRecord[]): MessageRecord[] {
  return messages.filter((message) => {
    return (
      (message.role === 'user' || message.role === 'assistant') &&
      message.contentText.trim().length > 0
    );
  });
}

