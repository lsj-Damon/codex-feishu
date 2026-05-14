import type { MessageRecord } from '../../core/types/domain.js';

export interface ConversationSummaryInput {
  messages: MessageRecord[];
}

export function generateConversationSummary(
  input: ConversationSummaryInput
): string | null {
  const messages = input.messages.filter((message) => {
    return (
      (message.role === 'user' || message.role === 'assistant') &&
      message.contentText.trim().length > 0
    );
  });

  if (messages.length < 4) {
    return null;
  }

  const combinedText = messages.map((message) => message.contentText).join('\n');
  const techStack = extractTechStack(combinedText);
  const errors = extractHighlights(messages, /error|exception|traceback|panic|SQLSTATE|cannot|failed|undefined|not found|syntax/i, 3);
  const attempts = extractHighlights(messages, /尝试|试过|改成|改为|换成|already tried|i tried|I changed|我改了|我用了/i, 3);
  const unresolved = extractLatestUserIssue(messages);

  const lines: string[] = [];
  if (techStack.length > 0) {
    lines.push(`技术栈: ${techStack.join(', ')}`);
  }
  if (errors.length > 0) {
    lines.push(`关键报错: ${errors.join(' | ')}`);
  }
  if (attempts.length > 0) {
    lines.push(`已尝试: ${attempts.join(' | ')}`);
  }
  if (unresolved) {
    lines.push(`当前问题: ${unresolved}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function extractTechStack(text: string): string[] {
  const matches = new Set<string>();
  const patterns: Array<[RegExp, string]> = [
    [/\bnode(?:\.js)?\b/i, 'Node.js'],
    [/\btypescript\b|\bts\b/i, 'TypeScript'],
    [/\bjavascript\b|\bjs\b/i, 'JavaScript'],
    [/\breact\b/i, 'React'],
    [/\bnext\.?js\b/i, 'Next.js'],
    [/\bvue\b/i, 'Vue'],
    [/\bsql\b|\bmysql\b|\bpostgres\b|\bpostgresql\b|\bsqlite\b/i, 'SQL'],
    [/\bgo\b|\bgolang\b/i, 'Go'],
    [/\bpython\b/i, 'Python'],
    [/\bjava\b/i, 'Java'],
    [/\bredis\b/i, 'Redis'],
    [/\bdocker\b/i, 'Docker']
  ];

  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) {
      matches.add(label);
    }
  }

  return [...matches];
}

function extractHighlights(
  messages: MessageRecord[],
  pattern: RegExp,
  limit: number
): string[] {
  const highlights: string[] = [];
  for (const message of messages) {
    const lines = message.contentText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (!pattern.test(line)) {
        continue;
      }

      const normalized = truncate(line, 140);
      if (!highlights.includes(normalized)) {
        highlights.push(normalized);
      }

      if (highlights.length >= limit) {
        return highlights;
      }
    }
  }

  return highlights;
}

function extractLatestUserIssue(messages: MessageRecord[]): string | null {
  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === 'user');
  if (!latestUser) {
    return null;
  }

  return truncate(latestUser.contentText.replace(/\s+/gu, ' ').trim(), 180);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

