import { randomUUID } from 'node:crypto';

import * as Lark from '@larksuiteoapi/node-sdk';

import type { AppConfig } from '../../core/config/index.js';
import type { AppLogger } from '../../core/logger/logger.js';
import type { FeishuReplyResult, FeishuReplyTextInput } from './types.js';

export class FeishuMessageClient {
  private readonly client: any;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger
  ) {
    const ClientCtor = (Lark as any).Client;
    this.client = new ClientCtor({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      appType: (Lark as any).AppType?.SelfBuild,
      domain:
        config.feishu.domain === 'lark'
          ? (Lark as any).Domain?.Lark
          : (Lark as any).Domain?.Feishu,
      loggerLevel: (Lark as any).LoggerLevel?.error
    });
  }

  public async replyText(input: FeishuReplyTextInput): Promise<FeishuReplyResult> {
    const textPayload = JSON.stringify({ text: input.text });
    const v1Message = this.client?.im?.v1?.message;

    if (input.replyToMessageId && typeof v1Message?.reply === 'function') {
      const response = await v1Message.reply({
        path: {
          message_id: input.replyToMessageId
        },
        data: {
          content: textPayload,
          msg_type: 'text',
          uuid: randomUUID()
        }
      });

      return {
        platformMessageId: extractPlatformMessageId(response),
        raw: response
      };
    }

    const createMethod =
      v1Message?.create ??
      this.client?.im?.message?.create;
    if (typeof createMethod !== 'function') {
      throw new Error('Feishu SDK message create method is unavailable.');
    }

    const response = await createMethod.call(v1Message ?? this.client.im.message, {
      params: {
        receive_id_type: 'chat_id'
      },
      data: {
        receive_id: input.chatId,
        content: textPayload,
        msg_type: 'text',
        uuid: randomUUID()
      }
    });

    this.logger.info('sent reply to feishu', {
      chatId: input.chatId,
      replyMode: input.replyToMessageId ? 'fallback-create' : 'create'
    });

    return {
      platformMessageId: extractPlatformMessageId(response),
      raw: response
    };
  }

  public async downloadImage(
    messageId: string,
    imageKey: string,
    localPath: string
  ): Promise<void> {
    try {
      const response = await this.client.im.messageResource.get({
        params: {
          type: 'image'
        },
        path: {
          message_id: messageId,
          file_key: imageKey
        }
      });

      await response.writeFile(localPath);
    } catch (error) {
      this.logger.warn('feishu messageResource image download failed', {
        messageId,
        imageKey,
        error: serializeFeishuError(error)
      });
      throw error;
    }
  }
}

function extractPlatformMessageId(response: any): string | null {
  return (
    response?.data?.message_id ??
    response?.data?.message?.message_id ??
    response?.message_id ??
    null
  );
}

function serializeFeishuError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return {
      message: String(error)
    };
  }

  const anyError = error as any;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: anyError.code ?? null,
    status: anyError.status ?? anyError.response?.status ?? null,
    responseData:
      anyError.response?.data ??
      anyError.response?.body ??
      anyError.data ??
      null,
    responseHeaders: anyError.response?.headers ?? null,
    logId:
      anyError.response?.data?.error?.log_id ??
      anyError.response?.data?.log_id ??
      null
  };
}
