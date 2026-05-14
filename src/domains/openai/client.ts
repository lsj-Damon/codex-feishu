import OpenAI from 'openai';

import type { AppConfig } from '../../core/config/index.js';
import type { AppLogger } from '../../core/logger/logger.js';
import type { MessageRole } from '../../core/types/domain.js';

export interface GeneratedReply {
  text: string;
  responseId: string | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  usedPreviousResponseId: boolean;
  fellBackFromPreviousResponseId: boolean;
}

export interface OpenAiRequestMessage {
  role: MessageRole;
  contentText: string;
}

export interface GenerateReplyInput {
  systemPrompt: string;
  continuationMessages: OpenAiRequestMessage[];
  fallbackMessages: OpenAiRequestMessage[];
  previousResponseId?: string | null;
  promptProfile: string;
  triggerImages?: Array<{
    dataUrl: string;
    mimeType: string;
  }>;
}

export class OpenAiResponsesClient {
  private readonly client: OpenAI;

  public constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger
  ) {
    if (!config.openai.apiKey) {
      throw new Error('OPENAI_API_KEY is required to create the OpenAI client.');
    }

    this.client = new OpenAI({
      apiKey: config.openai.apiKey,
      baseURL: config.openai.baseUrl
    });
  }

  public async generateReply(input: GenerateReplyInput): Promise<GeneratedReply> {
    const primaryMessages = buildResponseInput(
      input.systemPrompt,
      input.continuationMessages
    );

    try {
      const response = await this.createResponse(
        primaryMessages,
        input.previousResponseId ?? null,
        input.promptProfile,
        input.triggerImages ?? []
      );
      return {
        ...response,
        usedPreviousResponseId: Boolean(input.previousResponseId),
        fellBackFromPreviousResponseId: false
      };
    } catch (error) {
      if (
        input.previousResponseId &&
        isPreviousResponseFallbackError(error)
      ) {
        this.logger.warn('previous_response_id continuation failed, falling back to local context', {
          previousResponseId: input.previousResponseId,
          promptProfile: input.promptProfile,
          error: error instanceof Error ? error.message : String(error)
        });
        const fallbackResponse = await this.createResponse(
          buildResponseInput(input.systemPrompt, input.fallbackMessages),
          null,
          input.promptProfile,
          input.triggerImages ?? []
        );
        return {
          ...fallbackResponse,
          usedPreviousResponseId: false,
          fellBackFromPreviousResponseId: true
        };
      }

      throw error;
    }
  }

  private async createResponse(
    messages: Array<{ role: MessageRole; contentText: string }>,
    previousResponseId: string | null,
    promptProfile: string,
    triggerImages: Array<{ dataUrl: string; mimeType: string }>
  ): Promise<Omit<GeneratedReply, 'usedPreviousResponseId' | 'fellBackFromPreviousResponseId'>> {
    const responseInput: any = buildResponseMessages(messages, triggerImages);

    const response: any = await this.client.responses.create({
      model: this.config.openai.model,
      store: true,
      reasoning: {
        effort: 'medium'
      },
      previous_response_id: previousResponseId ?? undefined,
      input: responseInput
    });

    const text = extractResponseText(response);
    if (!text) {
      throw new Error('OpenAI returned an empty text response.');
    }

    this.logger.info('openai response generated', {
      model: response.model ?? this.config.openai.model,
      responseId: response.id ?? null,
      outputLength: text.length,
      promptProfile
    });

    return {
      text,
      responseId: response.id ?? null,
      model: response.model ?? this.config.openai.model,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null
    };
  }
}

function buildResponseInput(
  systemPrompt: string,
  messages: OpenAiRequestMessage[]
): Array<{ role: MessageRole; contentText: string }> {
  return [
    {
      role: 'system',
      contentText: systemPrompt
    },
    ...messages
  ];
}

function buildResponseMessages(
  messages: Array<{ role: MessageRole; contentText: string }>,
  triggerImages: Array<{ dataUrl: string; mimeType: string }>
) {
  return messages.map((message, index) => {
    const isLastMessage = index === messages.length - 1;
    const includeImages =
      message.role === 'user' && isLastMessage && triggerImages.length > 0;

    if (!includeImages) {
      return {
        role: message.role,
        content: [{ type: 'input_text', text: message.contentText }]
      };
    }

    const text =
      message.contentText.trim() === '[feishu:image]'
        ? 'The user sent an image in Feishu without extra text. Analyze the visible content and explain the likely issue or content concisely.'
        : message.contentText;

    return {
      role: message.role,
      content: [
        { type: 'input_text', text },
        ...triggerImages.map((image) => ({
          type: 'input_image',
          image_url: image.dataUrl
        }))
      ]
    };
  });
}

function isPreviousResponseFallbackError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('previous_response') ||
    message.includes('previous response') ||
    message.includes('not found') ||
    message.includes('invalid') ||
    message.includes('does not exist')
  );
}

function extractResponseText(response: any): string | null {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const outputs = Array.isArray(response?.output) ? response.output : [];
  for (const output of outputs) {
    const contents = Array.isArray(output?.content) ? output.content : [];
    for (const content of contents) {
      const text = content?.text;
      if (typeof text === 'string' && text.trim()) {
        return text.trim();
      }
    }
  }

  return null;
}
