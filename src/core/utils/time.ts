export function nowIso(): string {
  return new Date().toISOString();
}

export function addMilliseconds(isoTimestamp: string, milliseconds: number): string {
  return new Date(new Date(isoTimestamp).getTime() + milliseconds).toISOString();
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

