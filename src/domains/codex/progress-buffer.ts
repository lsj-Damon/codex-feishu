export class CodexProgressBuffer {
  private lastSentAt = 0;
  private lastText: string | null = null;

  public constructor(private readonly intervalMs: number) {}

  public shouldEmit(text: string, now = Date.now()): boolean {
    if (!text.trim()) {
      return false;
    }

    if (this.lastText === text) {
      return false;
    }

    if (this.intervalMs > 0 && now - this.lastSentAt < this.intervalMs) {
      return false;
    }

    this.lastSentAt = now;
    this.lastText = text;
    return true;
  }
}
