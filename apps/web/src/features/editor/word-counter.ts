import { countWords } from "../../lib/format";
import { onIdle } from "../../lib/idle";

/** Debounced, idle-time word count so the status bar never costs anything per keystroke. */
export class WordCounter {
  private readonly read: () => string | null;
  private readonly publish: (count: number | null) => void;
  private readonly delayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancelIdle: (() => void) | null = null;
  private lastEdit = 0;

  constructor(read: () => string | null, publish: (count: number | null) => void, delayMs = 600) {
    this.read = read;
    this.publish = publish;
    this.delayMs = delayMs;
  }

  schedule(delay = this.delayMs): void {
    this.lastEdit = performance.now();
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.fire(delay), delay);
  }

  private fire(delay: number): void {
    this.timer = undefined;
    const idle = performance.now() - this.lastEdit;
    if (idle < delay) {
      this.timer = setTimeout(() => this.fire(delay), delay - idle);
      return;
    }
    this.cancelIdle?.();
    this.cancelIdle = onIdle(() => {
      this.cancelIdle = null;
      const doc = this.read();
      this.publish(doc === null ? null : countWords(doc));
    }, 1000);
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.cancelIdle?.();
  }
}
