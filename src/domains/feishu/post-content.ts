export interface FeishuPostSummary {
  text: string;
  imageKeys: string[];
}

type FeishuPostLocaleBlock = {
  title?: unknown;
  content?: unknown;
};

type FeishuPostElement = {
  tag?: unknown;
  text?: unknown;
  image_key?: unknown;
  user_name?: unknown;
};

export function parseFeishuPostContent(raw: string): FeishuPostSummary | null {
  const parsed = parseFeishuPostRawContent(raw);
  const locale = findFeishuPostLocaleBlock(parsed);
  if (!locale || !Array.isArray(locale.content)) {
    return null;
  }

  const lines: string[] = [];
  const imageKeys: string[] = [];

  if (typeof locale.title === 'string' && locale.title.trim()) {
    lines.push(locale.title.trim());
  }

  for (const row of locale.content) {
    if (!Array.isArray(row)) {
      continue;
    }

    const lineParts: string[] = [];
    for (const item of row) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const element = item as FeishuPostElement;
      const tag = typeof element.tag === 'string' ? element.tag : '';

      if (tag === 'text' && typeof element.text === 'string') {
        lineParts.push(element.text);
      } else if (tag === 'at' && typeof element.user_name === 'string') {
        lineParts.push(`@${element.user_name}`);
      } else if (tag === 'img' && typeof element.image_key === 'string') {
        imageKeys.push(element.image_key);
      }
    }

    const line = lineParts.map((part) => part.trim()).filter(Boolean).join('').trim();
    if (line) {
      lines.push(line);
    }
  }

  return {
    text: lines.join('\n').trim(),
    imageKeys
  };
}

function parseFeishuPostRawContent(
  raw: string
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function findFeishuPostLocaleBlock(
  parsed: Record<string, unknown> | null
): FeishuPostLocaleBlock | null {
  if (!parsed) {
    return null;
  }

  if (Array.isArray((parsed as FeishuPostLocaleBlock).content)) {
    return parsed as FeishuPostLocaleBlock;
  }

  for (const value of Object.values(parsed)) {
    if (typeof value !== 'object' || value === null) {
      continue;
    }

    const candidate = value as FeishuPostLocaleBlock;
    if (Array.isArray(candidate.content)) {
      return candidate;
    }
  }

  return null;
}
