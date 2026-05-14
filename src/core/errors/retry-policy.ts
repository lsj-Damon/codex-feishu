export type FailureStage = 'generation' | 'delivery' | 'job';

export interface RetryDecision {
  code: string;
  retryable: boolean;
  message: string;
}

export function classifyFailure(
  error: unknown,
  stage: FailureStage
): RetryDecision {
  const details = getErrorDetails(error);

  if (details.code === 'SQLITE_BUSY' || details.message.includes('database is locked')) {
    return {
      code: 'SQLITE_BUSY',
      retryable: true,
      message: details.message || 'SQLite busy'
    };
  }

  if (
    details.status === 429 ||
    (details.status !== undefined && details.status >= 500)
  ) {
    return {
      code: `${stage.toUpperCase()}_TEMPORARY_HTTP`,
      retryable: true,
      message: details.message || `${stage} temporary http error`
    };
  }

  if (containsNetworkHint(details.message)) {
    return {
      code: `${stage.toUpperCase()}_NETWORK`,
      retryable: true,
      message: details.message || `${stage} network failure`
    };
  }

  if (details.status === 401 || details.status === 403) {
    return {
      code: `${stage.toUpperCase()}_AUTH`,
      retryable: false,
      message: details.message || `${stage} auth failure`
    };
  }

  if (details.status === 400 || details.status === 404) {
    return {
      code: `${stage.toUpperCase()}_INVALID_REQUEST`,
      retryable: false,
      message: details.message || `${stage} invalid request`
    };
  }

  if (containsPermanentHint(details.message)) {
    return {
      code: `${stage.toUpperCase()}_PERMANENT`,
      retryable: false,
      message: details.message
    };
  }

  return {
    code: `${stage.toUpperCase()}_UNEXPECTED`,
    retryable: false,
    message: details.message || `${stage} unexpected failure`
  };
}

export function computeRetryDelayMs(
  attempt: number,
  baseMs: number,
  maxDelayMs: number
): number {
  if (baseMs <= 0 || maxDelayMs <= 0) {
    return 0;
  }

  const safeAttempt = Math.max(attempt, 1);
  const jitter = Math.floor(Math.random() * 2000);
  const rawDelay = baseMs * 2 ** (safeAttempt - 1) + jitter;
  return Math.min(rawDelay, maxDelayMs);
}

function getErrorDetails(error: unknown): {
  status?: number;
  code?: string;
  message: string;
} {
  if (error instanceof Error) {
    const err = error as Error & {
      status?: number;
      statusCode?: number;
      code?: string;
      response?: { status?: number };
    };
    return {
      status: err.status ?? err.statusCode ?? err.response?.status,
      code: err.code,
      message: err.message
    };
  }

  return {
    message: String(error)
  };
}

function containsNetworkHint(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('network') ||
    lower.includes('econnreset') ||
    lower.includes('socket hang up') ||
    lower.includes('temporarily unavailable')
  );
}

function containsPermanentHint(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('invalid api key') ||
    lower.includes('unauthorized') ||
    lower.includes('permission') ||
    lower.includes('forbidden') ||
    lower.includes('invalid request')
  );
}

