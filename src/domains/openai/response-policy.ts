import type { MessageRecord } from '../../core/types/domain.js';

export type PromptProfile =
  | 'error_analysis'
  | 'code_explanation'
  | 'code_generation'
  | 'architecture_advice'
  | 'clarification'
  | 'meta_assistant'
  | 'image_analysis';

export interface ResponsePolicyContext {
  latestUserMessage: string;
  recentMessages: MessageRecord[];
  maxReplyChars: number;
}

export interface ResponsePolicyResult {
  promptProfile: PromptProfile;
  followUpQuestion: string | null;
  localReply: string | null;
  systemPrompt: string;
}

export function buildResponsePolicy(
  basePrompt: string,
  context: ResponsePolicyContext
): ResponsePolicyResult {
  const promptProfile = classifyPromptProfile(
    context.latestUserMessage,
    context.recentMessages
  );
  const localReply = buildLocalReply(
    promptProfile,
    context.latestUserMessage,
    context.recentMessages
  );
  const followUpQuestion = buildFollowUpQuestion(
    promptProfile,
    context.latestUserMessage,
    context.recentMessages
  );

  const profileInstruction = getProfileInstruction(
    promptProfile,
    context.maxReplyChars
  );
  const systemPrompt = `${basePrompt}\n${profileInstruction}`;

  return {
    promptProfile,
    followUpQuestion: localReply ? null : followUpQuestion,
    localReply,
    systemPrompt
  };
}

export function enforceReplyLength(text: string, maxReplyChars: number): string {
  if (maxReplyChars <= 0 || text.length <= maxReplyChars) {
    return text.trim();
  }

  return `${text.slice(0, Math.max(0, maxReplyChars - 1)).trimEnd()}…`;
}

function classifyPromptProfile(
  latestUserMessage: string,
  recentMessages: MessageRecord[]
): PromptProfile {
  const text = latestUserMessage.trim();
  const lower = text.toLowerCase();
  void lower;

  if (isMetaAssistantQuestion(text)) {
    return 'meta_assistant';
  }

  if (/^\[feishu:image\]$/u.test(text)) {
    return 'image_analysis';
  }

  if (needsClarification(text, recentMessages)) {
    return 'clarification';
  }

  if (
    /error|exception|traceback|panic|报错|异常|失败|cannot|undefined|not found|sqlstate/i.test(
      text
    )
  ) {
    return 'error_analysis';
  }

  if (/解释|看懂|什么意思|why|how does|explain/i.test(text)) {
    return 'code_explanation';
  }

  if (/生成|写一个|实现|帮我写|create|generate|implement|build/i.test(text)) {
    return 'code_generation';
  }

  if (/架构|方案|设计|trade-?off|architecture|design/i.test(text)) {
    return 'architecture_advice';
  }

  return 'error_analysis';
}

function buildLocalReply(
  promptProfile: PromptProfile,
  latestUserMessage: string,
  recentMessages: MessageRecord[]
): string | null {
  const text = latestUserMessage.replace(/\s+/gu, ' ').trim();
  const lower = text.toLowerCase();

  if (
    promptProfile !== 'meta_assistant' &&
    !/什么意思/u.test(text)
  ) {
    return null;
  }

  if (/^(你是|你是谁)[？?]?$/u.test(text)) {
    return '我是飞书里的本地代码助手，可以帮你分析报错、解释代码、生成小段代码和梳理技术方案。';
  }

  if (/你能做什么|能做什么|会什么/u.test(text)) {
    return '我可以帮你分析报错、解释代码、生成小段代码、排查 SQL 和命令问题，也可以一起梳理实现方案。';
  }

  if (
    /codex.*(没|没有).*(显示|同步)|飞书.*codex.*(没|没有).*(显示|同步)|界面.*没显示/u.test(
      text
    )
  ) {
    return '因为当前服务只负责在飞书里收消息、调用模型并把结果回到飞书，没有把会话同步到 Codex 界面，所以飞书里的提问不会自动显示到 Codex 界面。';
  }

  const mentionsCodex = lower.includes('codex');
  const mentionsFeishu = /飞书/u.test(text);
  const mentionsUiOrVisibility =
    /界面|显示|看到|可见|同步|记录/u.test(text);
  if (mentionsCodex && mentionsFeishu && mentionsUiOrVisibility) {
    return '当前服务只负责在飞书里收消息、调用模型并把结果回到飞书，不会把飞书里的会话记录同步到 Codex 界面，所以你不会在 Codex 界面里自动看到这些飞书消息。';
  }

  if (/^\[feishu:file\]$/u.test(text)) {
    return '我收到了文件消息，但当前还不能直接解析附件内容。请把关键报错、代码片段或问题描述转成文字发给我。';
  }

  if (/什么意思/u.test(text)) {
    const previousAssistant = [...recentMessages]
      .reverse()
      .find((message) => message.role === 'assistant');
    if (previousAssistant) {
      return '我的意思是：如果你希望我定位具体技术问题，需要补充报错、相关代码片段，或者你期望的结果。';
    }
  }

  if (/你是什么|你干嘛的/u.test(text)) {
    return '我是飞书里的本地代码助手，主要负责代码问答、报错分析和方案建议。';
  }

  return null;
}

function buildFollowUpQuestion(
  promptProfile: PromptProfile,
  latestUserMessage: string,
  recentMessages: MessageRecord[]
): string | null {
  if (promptProfile !== 'clarification') {
    return null;
  }

  const text = latestUserMessage.trim();
  if (/报错|error|exception|panic/i.test(text)) {
    return '把完整报错和触发它的代码片段贴一下。';
  }

  if (/代码|函数|方法|类|sql|query/i.test(text)) {
    return '把相关代码片段和你期望的结果一起贴一下。';
  }

  const hasContext = recentMessages.some((message) => {
    return (
      message.role === 'user' &&
      message.contentText.trim().length >= 20 &&
      message.contentText !== latestUserMessage
    );
  });

  if (hasContext) {
    return '你现在最想解决的是哪一层的问题：报错、代码实现，还是整体方案？';
  }

  return '把完整报错、相关代码片段，或者你期望的结果补充一下。';
}

function getProfileInstruction(
  promptProfile: PromptProfile,
  maxReplyChars: number
): string {
  const maxCharsInstruction =
    maxReplyChars > 0
      ? `Keep the default reply under roughly ${maxReplyChars} characters unless a longer answer is clearly necessary.`
      : '';

  switch (promptProfile) {
    case 'error_analysis':
      return `Prioritize error diagnosis. Lead with the likely cause, then the reason, then the smallest fix path. ${maxCharsInstruction}`.trim();
    case 'code_explanation':
      return `Prioritize explaining the code path or behavior clearly and concretely. ${maxCharsInstruction}`.trim();
    case 'code_generation':
      return `Prioritize the smallest correct implementation or patch with brief rationale. ${maxCharsInstruction}`.trim();
    case 'architecture_advice':
      return `Prioritize trade-offs, recommendation, and practical next steps. ${maxCharsInstruction}`.trim();
    case 'clarification':
      return `If the context is insufficient, ask one short follow-up question instead of guessing. ${maxCharsInstruction}`.trim();
    case 'meta_assistant':
      return `Answer capability or product-behavior questions directly and briefly. ${maxCharsInstruction}`.trim();
    case 'image_analysis':
      return `Analyze the provided image content directly. If it looks like a screenshot of code, logs, or errors, explain the visible issue first, then give the smallest useful next step. ${maxCharsInstruction}`.trim();
    default:
      return maxCharsInstruction.trim();
  }
}

function needsClarification(
  latestUserMessage: string,
  recentMessages: MessageRecord[]
): boolean {
  const text = latestUserMessage.replace(/\s+/gu, ' ').trim();
  if (isDirectActionRequest(text)) {
    return false;
  }

  if (text.length < 10) {
    return true;
  }

  if (/^(你好|在吗|帮我看看|帮我看下|有问题|有个问题|有报错|怎么搞|咋办|看一下)$/iu.test(text)) {
    return true;
  }

  const hasStrongSignal =
    /```|stack trace|traceback|panic|error|exception|报错|异常|SELECT |INSERT |UPDATE |DELETE |function |class /i.test(
      text
    );
  if (hasStrongSignal) {
    return false;
  }

  const recentContextHasStrongSignal = recentMessages.some((message) => {
    return (
      message.role === 'user' &&
      /```|stack trace|traceback|panic|error|exception|报错|异常|sqlstate|SELECT |INSERT |UPDATE |DELETE |function |class /i.test(
        message.contentText
      )
    );
  });
  if (
    recentContextHasStrongSignal &&
    /(这个|上面|贴出来|这段|这个问题|这个报错|这个 sql|这个查询|错误位置)/iu.test(
      text
    )
  ) {
    return false;
  }

  const hasPriorRichContext = recentMessages.some((message) => {
    return (
      message.role === 'user' &&
      message.contentText.trim().length >= 50 &&
      message.contentText !== latestUserMessage
    );
  });

  return !hasPriorRichContext;
}

function isDirectActionRequest(text: string): boolean {
  return /^(解析|分析|看看|看下|解释|说明|总结|指出|判断|识别|描述|比较|帮我分析|帮我看看|帮我解释).*/u.test(
    text
  );
}

function isMetaAssistantQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  const mentionsCodex = lower.includes('codex');
  const mentionsFeishu = /飞书/u.test(text);
  const mentionsUiOrVisibility =
    /界面|显示|看到|可见|同步|记录/u.test(text);

  return /^(你是|你是谁|你是什么|你能做什么|能做什么|你干嘛的)[？?]?$/u.test(text) ||
    /codex.*(没|没有).*(显示|同步)|飞书.*codex.*(没|没有).*(显示|同步)|界面.*没显示|^\[feishu:file\]$/u.test(text) ||
    (mentionsCodex && mentionsFeishu && mentionsUiOrVisibility);
}
