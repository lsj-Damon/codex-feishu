export type Platform = 'feishu';
export type AppRole = 'gateway' | 'worker';
export type MessageRole = 'user' | 'assistant' | 'system';
export type JobType = 'reply_generation';
export type JobStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type DeliveryStatus =
  | 'queued'
  | 'sending'
  | 'retry_wait'
  | 'succeeded'
  | 'failed';
export type JobAttemptOutcome = 'succeeded' | 'retry_scheduled' | 'failed';
export type AttachmentStatus = 'pending' | 'downloaded' | 'failed';
export type AttachmentKind = 'image';
export type ExecutionBackend = 'openai' | 'codex';
export type CodexSessionStatus =
  | 'active'
  | 'idle'
  | 'busy'
  | 'broken'
  | 'archived';
export type CodexRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface NormalizedAttachment {
  kind: AttachmentKind;
  remoteKey: string;
  attachmentIndex: number;
  metadataJson?: string | null;
}

export interface NormalizedInboundMessage {
  platform: Platform;
  eventId: string;
  eventType: string;
  platformMessageId: string;
  chatId: string;
  chatType: string;
  senderOpenId: string;
  conversationKey: string;
  text: string;
  messageType: string;
  attachments: NormalizedAttachment[];
  mentionOpenIds: string[];
  mentioned: boolean;
  receivedAt: string;
  rawPayloadJson: string;
}

export interface ConversationRecord {
  id: number;
  platform: Platform;
  conversationKey: string;
  chatId: string;
  chatType: string;
  userOpenId: string | null;
  status: string;
  lastUserMessageId: number | null;
  lastAssistantMessageId: number | null;
  lastResponseId: string | null;
  summaryText: string | null;
  workspaceRoot: string | null;
  currentProjectName: string | null;
  currentProjectPath: string | null;
  activeSessionId: number | null;
  activeBackend: ExecutionBackend;
  lastSwitchAt: string | null;
  messageCount: number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: number;
  platform: Platform;
  conversationId: number;
  platformMessageId: string | null;
  replyToMessageId: string | null;
  role: MessageRole;
  senderOpenId: string | null;
  contentText: string;
  contentJson: string | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  model: string | null;
  responseId: string | null;
  status: string;
  createdAt: string;
}

export interface JobRecord {
  id: number;
  jobType: JobType;
  conversationId: number;
  triggerMessageId: number;
  status: JobStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  lockedBy: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  resultMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryRecord {
  id: number;
  jobId: number;
  assistantMessageId: number;
  platform: Platform;
  deliveryType: string;
  status: DeliveryStatus;
  platformMessageId: string | null;
  attemptCount: number;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageAttachmentRecord {
  id: number;
  messageId: number;
  attachmentIndex: number;
  provider: Platform;
  attachmentKind: AttachmentKind;
  remoteKey: string;
  localPath: string | null;
  mimeType: string | null;
  status: AttachmentStatus;
  width: number | null;
  height: number | null;
  metadataJson: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodexSessionRecord {
  id: number;
  conversationId: number;
  projectName: string;
  projectPath: string;
  codexSessionId: string | null;
  status: CodexSessionStatus;
  createdAt: string;
  lastActiveAt: string;
  archivedAt: string | null;
}

export interface CodexRunRecord {
  id: number;
  sessionId: number;
  jobId: number;
  userMessageId: number;
  promptText: string;
  status: CodexRunStatus;
  exitCode: number | null;
  jsonlPath: string | null;
  stderrPath: string | null;
  finalReplyText: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface CodexStreamEventRecord {
  id: number;
  runId: number;
  sequenceNo: number;
  eventType: string;
  payloadJson: string;
  createdAt: string;
  pushedToFeishu: boolean;
  feishuMessageId: string | null;
}
