import type {
  ConversationRecord,
  MessageRecord,
  MessageRole
} from '../../core/types/domain.js';
import { generateConversationSummary } from '../conversation/summary.js';
import {
  buildResponsePolicy,
  type PromptProfile
} from './response-policy.js';
import { SYSTEM_PROMPT } from './prompt.js';

export interface OpenAiInputMessage {
  role: MessageRole;
  contentText: string;
}

export interface ConversationContextInput {
  conversation: ConversationRecord;
  messages: MessageRecord[];
  maxContextMessages: number;
  maxMessageChars: number;
  maxReplyChars: number;
  summaryTriggerMessageCount: number;
  summaryRefreshInterval: number;
}

export interface ConversationContextResult {
  promptProfile: PromptProfile;
  followUpQuestion: string | null;
  localReply: string | null;
  systemPrompt: string;
  previousResponseId: string | null;
  continuationMessages: OpenAiInputMessage[];
  fallbackMessages: OpenAiInputMessage[];
  generatedSummaryText: string | null;
}

export function buildConversationContext(
  input: ConversationContextInput
): ConversationContextResult {
  const recentRelevantMessages = selectRelevantMessages(
    input.messages,
    input.maxContextMessages,
    input.maxMessageChars
  );
  const latestUserMessage =
    [...recentRelevantMessages]
      .reverse()
      .find((message) => message.role === 'user') ??
    [...input.messages].reverse().find((message) => message.role === 'user');

  const latestUserText = latestUserMessage?.contentText.trim() ?? '';
  const policy = buildResponsePolicy(SYSTEM_PROMPT, {
    latestUserMessage: latestUserText,
    recentMessages: recentRelevantMessages,
    maxReplyChars: input.maxReplyChars
  });

  const generatedSummaryText = shouldRefreshSummary(
    input.conversation,
    recentRelevantMessages,
    input.summaryTriggerMessageCount,
    input.summaryRefreshInterval
  )
    ? generateConversationSummary({ messages: recentRelevantMessages })
    : null;
  const summaryText =
    generatedSummaryText?.trim() || input.conversation.summaryText?.trim() || null;

  const continuationMessages = latestUserMessage
    ? [toInputMessage(latestUserMessage)]
    : recentRelevantMessages.slice(-1).map(toInputMessage);
  const fallbackMessages = [
    ...buildSummaryMessages(summaryText),
    ...recentRelevantMessages
      .slice(-Math.max(input.maxContextMessages, 1))
      .map(toInputMessage)
  ];

  return {
    promptProfile: policy.promptProfile,
    followUpQuestion: policy.followUpQuestion,
    localReply: policy.localReply,
    systemPrompt: policy.systemPrompt,
    previousResponseId:
      policy.followUpQuestion === null && policy.localReply === null
        ? input.conversation.lastResponseId
        : null,
    continuationMessages,
    fallbackMessages: fallbackMessages.filter(
      (message) => message.contentText.trim().length > 0
    ),
    generatedSummaryText
  };
}

function shouldRefreshSummary(
  conversation: ConversationRecord,
  messages: MessageRecord[],
  triggerCount: number,
  refreshInterval: number
): boolean {
  if (conversation.messageCount < triggerCount) {
    return false;
  }

  if (messages.length < Math.max(4, Math.floor(triggerCount / 2))) {
    return false;
  }

  if (!conversation.summaryText) {
    return true;
  }

  if (refreshInterval <= 0) {
    return false;
  }

  return conversation.messageCount % refreshInterval === 0;
}

function selectRelevantMessages(
  messages: MessageRecord[],
  maxContextMessages: number,
  maxMessageChars: number
): MessageRecord[] {
  const relevantMessages = messages.filter((message) => {
    return (
      (message.role === 'user' || message.role === 'assistant') &&
      message.contentText.trim().length > 0 &&
      !isLowSignalChat(message.contentText)
    );
  });

  return relevantMessages
    .slice(-Math.max(maxContextMessages, 1))
    .map((message) => ({
      ...message,
      contentText: trimMessageContent(message.contentText, maxMessageChars)
    }));
}

function buildSummaryMessages(summaryText: string | null): OpenAiInputMessage[] {
  if (!summaryText) {
    return [];
  }

  return [
    {
      role: 'system',
      contentText: `Conversation summary:\n${summaryText}`
    }
  ];
}

function toInputMessage(message: MessageRecord): OpenAiInputMessage {
  return {
    role: message.role,
    contentText: message.contentText
  };
}

function trimMessageContent(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (maxChars <= 0 || trimmed.length <= maxChars) {
    return trimmed;
  }

  if (maxChars < 200) {
    return `${trimmed.slice(0, maxChars).trimEnd()}…`;
  }

  const head = trimmed.slice(0, Math.floor(maxChars * 0.7)).trimEnd();
  const tail = trimmed.slice(-Math.floor(maxChars * 0.2)).trimStart();
  return `${head}\n...\n${tail}`;
}

function isLowSignalChat(text: string): boolean {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return /^(收到|好的|谢谢|thanks|ok|okay|好的我试试|明白了|你好|hi|hello)$/iu.test(
    normalized
  );
}
