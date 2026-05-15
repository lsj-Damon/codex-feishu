import type { CodexRawEvent, CodexTranslatedEvent } from './types.js';

export function translateCodexEvent(event: CodexRawEvent): CodexTranslatedEvent[] {
  if (event.type === 'thread.started') {
    return [
      {
        kind: 'progress',
        category: 'session',
        text: 'Codex 会话已创建，开始准备执行。',
        eventType: event.type
      }
    ];
  }

  if (event.type === 'turn.started') {
    return [
      {
        kind: 'progress',
        category: 'turn',
        text: 'Codex 已开始处理当前请求。',
        eventType: event.type
      }
    ];
  }

  if (event.type === 'turn.completed') {
    return [
      {
        kind: 'progress',
        category: 'status',
        text: 'Codex 已完成当前轮处理，正在整理结果。',
        eventType: event.type
      }
    ];
  }

  if (event.type === 'progress.message' && typeof event.text === 'string') {
    return [
      {
        kind: 'progress',
        category: 'status',
        text: event.text,
        eventType: event.type
      }
    ];
  }

  if (event.type === 'item.started') {
    return translateStartedItem(event.item);
  }

  if (event.type === 'item.completed') {
    return translateCompletedItem(event.item);
  }

  return [];
}

function translateStartedItem(item: unknown): CodexTranslatedEvent[] {
  if (!item || typeof item !== 'object') {
    return [];
  }

  const typedItem = item as {
    type?: string;
    server?: string;
    tool?: string;
    command?: string;
  };

  if (typedItem.type === 'mcp_tool_call') {
    return [
      {
        kind: 'progress',
        category: 'tool',
        text: formatToolStart(typedItem.server, typedItem.tool),
        eventType: 'item.started',
        itemType: typedItem.type,
        status: 'in_progress'
      }
    ];
  }

  if (typedItem.type === 'command_execution') {
    return [
      {
        kind: 'progress',
        category: 'command',
        text: formatCommandStart(typedItem.command),
        eventType: 'item.started',
        itemType: typedItem.type,
        status: 'in_progress'
      }
    ];
  }

  return [];
}

function translateCompletedItem(item: unknown): CodexTranslatedEvent[] {
  if (!item || typeof item !== 'object') {
    return [];
  }

  const typedItem = item as {
    type?: string;
    text?: string;
    server?: string;
    tool?: string;
    command?: string;
    error?: { message?: string } | null;
    status?: string;
    exit_code?: number | null;
  };

  if (typedItem.type === 'agent_message' && typeof typedItem.text === 'string') {
    return [
      {
        kind: 'final',
        category: 'final',
        text: typedItem.text,
        eventType: 'item.completed',
        itemType: typedItem.type,
        status: typedItem.status
      }
    ];
  }

  if (typedItem.type === 'mcp_tool_call') {
    return [
      {
        kind: 'progress',
        category: typedItem.error?.message ? 'warning' : 'tool',
        text: formatToolCompletion(
          typedItem.server,
          typedItem.tool,
          typedItem.status,
          typedItem.error?.message
        ),
        eventType: 'item.completed',
        itemType: typedItem.type,
        status: typedItem.status
      }
    ];
  }

  if (typedItem.type === 'command_execution') {
    return [
      {
        kind: 'progress',
        category:
          typedItem.exit_code !== null &&
          typedItem.exit_code !== undefined &&
          typedItem.exit_code !== 0
            ? 'warning'
            : 'command',
        text: formatCommandCompletion(
          typedItem.command,
          typedItem.status,
          typedItem.exit_code
        ),
        eventType: 'item.completed',
        itemType: typedItem.type,
        status: typedItem.status
      }
    ];
  }

  return [];
}

function formatToolStart(server?: string, tool?: string): string {
  if (server && tool) {
    return `正在调用工具 ${server}/${tool}`;
  }
  if (tool) {
    return `正在调用工具 ${tool}`;
  }
  return '正在调用工具';
}

function formatToolCompletion(
  server?: string,
  tool?: string,
  status?: string,
  errorMessage?: string
): string {
  const name =
    server && tool ? `${server}/${tool}` : tool ?? server ?? '工具调用';
  if (errorMessage) {
    return `${name} 调用失败：${errorMessage}`;
  }
  if (status === 'completed') {
    return `${name} 调用完成`;
  }
  if (status) {
    return `${name} 状态：${status}`;
  }
  return `${name} 已结束`;
}

function formatCommandStart(command?: string): string {
  if (!command) {
    return '正在执行命令';
  }
  return `正在执行命令：${truncate(command)}`;
}

function formatCommandCompletion(
  command?: string,
  status?: string,
  exitCode?: number | null
): string {
  const prefix = command
    ? `命令完成：${truncate(command)}`
    : '命令执行完成';

  if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    return `${prefix}（exit ${exitCode}）`;
  }

  if (status && status !== 'completed') {
    return `${prefix}（${status}）`;
  }

  return prefix;
}

function truncate(value: string, max = 80): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 3)}...`;
}
