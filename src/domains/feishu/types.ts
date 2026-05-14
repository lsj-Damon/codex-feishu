import type { NormalizedInboundMessage } from '../../core/types/domain.js';

export interface FeishuMessageEventEnvelope {
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
  };
  event?: {
    sender?: {
      sender_id?: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      sender_type?: string;
      tenant_key?: string;
    };
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      create_time?: string;
      update_time?: string;
      chat_id?: string;
      thread_id?: string;
      chat_type?: string;
      message_type?: string;
      content?: string;
      mentions?: Array<{
        key?: string;
        name?: string;
        id?: {
          union_id?: string;
          user_id?: string;
          open_id?: string;
        };
        tenant_key?: string;
      }>;
      user_agent?: string;
    };
  };
  sender?: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type?: string;
    tenant_key?: string;
  };
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    create_time?: string;
    update_time?: string;
    chat_id?: string;
    thread_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{
      key?: string;
      name?: string;
      id?: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

export interface FeishuReplyTextInput {
  chatId: string;
  replyToMessageId: string | null;
  text: string;
}

export interface FeishuReplyResult {
  platformMessageId: string | null;
  raw: unknown;
}

export type FeishuEventHandler = (
  payload: FeishuMessageEventEnvelope
) => Promise<void>;

export interface NormalizedFeishuMessage extends NormalizedInboundMessage {}
