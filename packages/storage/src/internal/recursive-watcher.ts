import { type FSWatcher, watch } from "node:fs";
import { type Logger, normalizePath } from "@ddl/core";
import { errorMessage } from "./fs-errors";

export type WatchFactory = (
  root: string,
  listener: (eventType: string, filename: string | null) => void,
) => FSWatcher;

const defaultWatchFactory: WatchFactory = (root, listener) =>
  watch(root, { recursive: true, persistent: false, encoding: "utf8" }, listener);

export interface RecursiveWatcherOptions {
  /** Absolute, real path of the folder to watch. */
  root: string;
  logger: Logger;
  /** Something changed at this vault-relative path (file or folder). */
  onChange(path: string): void;
  /** Events may have been lost (no file name, or the watcher restarted): reconcile everything. */
  onRescan(): void;
  /** Injection point for tests. */
  watchFactory?: WatchFactory;
  minRestartDelayMs?: number;
  maxRestartDelayMs?: number;
}

/**
 * `fs.watch(root, { recursive: true })` (FSEvents on macOS, inotify on Linux) that survives
 * errors: a failed watcher is closed and reopened with exponential backoff, followed by a rescan
 * because events may have been dropped in between.
 */
export class RecursiveWatcher {
  private readonly options: RecursiveWatcherOptions;
  private readonly factory: WatchFactory;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private watcher: FSWatcher | undefined;
  private openedAt = 0;
  private restartDelay: number;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(options: RecursiveWatcherOptions) {
    this.options = options;
    this.factory = options.watchFactory ?? defaultWatchFactory;
    this.minDelay = options.minRestartDelayMs ?? 100;
    this.maxDelay = options.maxRestartDelayMs ?? 30_000;
    this.restartDelay = this.minDelay;
  }

  start(): void {
    this.open(false);
  }

  close(): void {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const watcher = this.watcher;
    this.watcher = undefined;
    watcher?.close();
  }

  get active(): boolean {
    return this.watcher !== undefined;
  }

  private open(isRestart: boolean): void {
    if (this.closed) return;
    let watcher: FSWatcher;
    try {
      watcher = this.factory(this.options.root, (eventType, filename) =>
        this.handle(eventType, filename),
      );
    } catch (error) {
      this.options.logger.warn("could not start file watcher", { error: errorMessage(error) });
      this.scheduleRestart();
      return;
    }
    watcher.on("error", (error: unknown) => this.fail(watcher, error));
    this.watcher = watcher;
    this.openedAt = Date.now();
    if (isRestart) {
      this.options.logger.info("file watcher restarted");
      this.options.onRescan();
    }
  }

  private handle(_eventType: string, filename: string | null): void {
    if (this.closed) return;
    if (!filename) {
      this.options.onRescan();
      return;
    }
    let path: string;
    try {
      path = normalizePath(filename);
    } catch {
      return;
    }
    if (path === "") this.options.onRescan();
    else this.options.onChange(path);
  }

  private fail(watcher: FSWatcher, error: unknown): void {
    if (watcher !== this.watcher) return;
    this.options.logger.warn("file watcher failed; restarting", { error: errorMessage(error) });
    this.watcher = undefined;
    try {
      watcher.close();
    } catch {
      // Already torn down by the error.
    }
    // A watcher that stayed healthy for a while earns a fresh backoff.
    if (Date.now() - this.openedAt > this.maxDelay) this.restartDelay = this.minDelay;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, this.maxDelay);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.open(true);
    }, delay);
    this.restartTimer.unref?.();
  }
}
