import type { NormalizedInboundMessage } from '../../core/types/domain.js';
import { parseFeishuPostContent } from './post-content.js';
import type { FeishuMessageEventEnvelope } from './types.js';

export function normalizeFeishuMessageEvent(
  payload: FeishuMessageEventEnvelope
): NormalizedInboundMessage | null {
  const header = payload.header;
  const event = payload.event ?? payload;
  const message = event?.message;
  const sender = event?.sender;
  const eventId = header?.event_id ?? message?.message_id ?? null;
  const eventType = header?.event_type ?? 'im.message.receive_v1';

  if (!eventId || !message?.message_id || !message.chat_id) {
    return null;
  }

  if (message.chat_type !== 'p2p' && message.chat_type !== 'group') {
    return null;
  }

  if (sender?.sender_type === 'bot') {
    return null;
  }

  const text = extractMessageText(message.message_type, message.content);
  if (!text) {
    return null;
  }

  const senderOpenId = sender?.sender_id?.open_id ?? '';
  const mentionOpenIds = (message.mentions ?? [])
    .map((mention) => mention.id?.open_id?.trim())
    .filter((openId): openId is string => Boolean(openId));

  return {
    platform: 'feishu',
    eventId,
    eventType,
    platformMessageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    senderOpenId,
    conversationKey:
      message.chat_type === 'group'
        ? `${message.chat_id}:${senderOpenId}`
        : message.chat_id,
    text,
    messageType: message.message_type ?? 'text',
    attachments: extractAttachments(message.message_type, message.content),
    mentionOpenIds,
    mentioned: mentionOpenIds.length > 0,
    receivedAt: new Date().toISOString(),
    rawPayloadJson: JSON.stringify(payload)
  };
}

function extractMessageText(
  messageType: string | undefined,
  content: string | undefined
): string | null {
  if (messageType === 'image') {
    return '[feishu:image]';
  }

  if (messageType === 'file') {
    return '[feishu:file]';
  }

  if (messageType === 'audio') {
    return '[feishu:audio]';
  }

  if (messageType === 'video') {
    return '[feishu:video]';
  }

  if (messageType && messageType !== 'text') {
    if (messageType === 'post' && content) {
      const summary = parseFeishuPostContent(content);
      if (summary?.text) {
        return summary.text;
      }
      if (summary && summary.imageKeys.length > 0) {
        return '[feishu:image]';
      }
    }
    return `[feishu:${messageType}]`;
  }

  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as { text?: string };
    const text = parsed.text?.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

function extractAttachments(
  messageType: string | undefined,
  content: string | undefined
) {
  if (!content) {
    return [];
  }

  if (messageType === 'image') {
    try {
      const parsed = JSON.parse(content) as { image_key?: string };
      if (parsed.image_key?.trim()) {
        return [
          {
            kind: 'image' as const,
            remoteKey: parsed.image_key.trim(),
            attachmentIndex: 0,
            metadataJson: JSON.stringify({ image_key: parsed.image_key.trim() })
          }
        ];
      }
    } catch {
      return [];
    }
    return [];
  }

  if (messageType === 'post') {
    const summary = parseFeishuPostContent(content);
    if (!summary) {
      return [];
    }

    return summary.imageKeys.map((remoteKey, index) => ({
      kind: 'image' as const,
      remoteKey,
      attachmentIndex: index,
      metadataJson: JSON.stringify({ image_key: remoteKey })
    }));
  }

  return [];
}
