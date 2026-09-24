import { type Throttled, throttle } from "../../lib/throttle";

/**
 * Tells the daemon where the user is typing (`editor.activity`) so the orchestrator never jumps
 * on a half-written task. Throttled; sent on line changes and while typing on the same line.
 */
export class PresenceReporter {
  private path: string | null = null;
  private line: number | null = null;
  private lastSent = "";
  private readonly throttled: Throttled<[string, number]>;

  constructor(send: (notePath: string, line: number) => void, intervalMs = 400) {
    this.throttled = throttle((notePath: string, line: number) => {
      this.lastSent = `${notePath}\u0000${line}`;
      send(notePath, line);
    }, intervalMs);
  }

  onCursorLine(path: string, line: number): void {
    this.path = path;
    this.line = line;
    if (this.lastSent !== `${path}\u0000${line}`) this.throttled(path, line);
  }

  onEdit(path: string): void {
    if (this.path === path && this.line !== null) this.throttled(path, this.line);
  }

  reset(): void {
    this.throttled.cancel();
    this.path = null;
    this.line = null;
    this.lastSent = "";
  }
}
