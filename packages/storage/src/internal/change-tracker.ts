import type { Logger } from "@ddl/core";
import { isUnderPrefix } from "../ignore-rules";
import type { StorageEvent } from "../types";
import { errorMessage } from "./fs-errors";

export type PathProbe =
  | { type: "file"; version: string }
  | { type: "directory" }
  | { type: "missing" };

export interface ChangeTrackerHost {
  /** Fresh look at one path (reads the file; no caches). */
  probe(path: string): Promise<PathProbe>;
  /** Current watchable files below `prefix` (`""` = whole vault) and their versions. */
  listFiles(prefix: string): Promise<Map<string, string>>;
  /** Serializes with the provider's own writes to the same path. */
  withLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
  emit(event: StorageEvent): void;
}

export interface ChangeTrackerOptions {
  /** Per-path quiet period before a raw fs event is looked at. */
  debounceMs: number;
  /**
   * How long a known file may be missing before it is reported deleted. Absorbs saves that
   * remove/rename the original before the new content lands, turning them into one `modified`.
   */
  deleteGraceMs: number;
  logger: Logger;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Turns noisy, lossy fs notifications into precise `created`/`modified`/`deleted` events by
 * comparing what is on disk with the last version reported to subscribers (`known`). Because the
 * provider records its own writes here first (under the same per-path lock), the watcher's echo of
 * those writes compares equal and is dropped; so is a touch that leaves content unchanged.
 */
export class ChangeTracker {
  private readonly host: ChangeTrackerHost;
  private readonly options: ChangeTrackerOptions;
  private readonly known = new Map<string, string>();
  private readonly timers = new Map<string, Timer>();
  private readonly deleteTimers = new Map<string, Timer>();
  private readonly inflight = new Set<Promise<void>>();
  /** Paths the provider changed while the baseline scan ran; the scan's view of them is stale. */
  private readonly touchedWhilePriming = new Set<string>();
  private rescanTimer: Timer | undefined;
  private primed: Promise<void> = Promise.resolve();
  private priming = false;
  private stopped = false;

  constructor(host: ChangeTrackerHost, options: ChangeTrackerOptions) {
    this.host = host;
    this.options = options;
  }

  /** Records the baseline state of the vault. Resolves once events can be classified. */
  start(): Promise<void> {
    this.primed = this.prime();
    return this.primed;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.deleteTimers.values()) clearTimeout(timer);
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.timers.clear();
    this.deleteTimers.clear();
    this.rescanTimer = undefined;
    await Promise.all([...this.inflight]);
    this.known.clear();
  }

  /** The provider changed `path` itself (`version: null` = deleted). Call under the path lock. */
  recordSelf(path: string, version: string | null): void {
    this.cancelDeleteConfirmation(path);
    if (this.priming) this.touchedWhilePriming.add(path);
    if (version === null) this.known.delete(path);
    else this.known.set(path, version);
  }

  /** Raw fs notification for a (non-ignored) path. */
  notify(path: string): void {
    if (this.stopped) return;
    const existing = this.timers.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(path);
      this.track(this.process(path));
    }, this.options.debounceMs);
    this.timers.set(path, timer);
  }

  /** Reconcile the whole vault (events may have been lost). */
  requestRescan(): void {
    if (this.stopped) return;
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = undefined;
      this.track(this.primed.then(() => this.rescan("")));
    }, this.options.debounceMs);
  }

  private async prime(): Promise<void> {
    this.priming = true;
    try {
      const files = await this.host.listFiles("");
      for (const [path, version] of files) {
        if (!this.touchedWhilePriming.has(path) && !this.known.has(path)) {
          this.known.set(path, version);
        }
      }
    } catch (error) {
      this.options.logger.error("could not scan the vault for the watcher", {
        error: errorMessage(error),
      });
    } finally {
      this.priming = false;
      this.touchedWhilePriming.clear();
    }
  }

  private track(work: Promise<void>): void {
    const guarded = work.catch((error: unknown) => {
      this.options.logger.warn("failed to process a file change", { error: errorMessage(error) });
    });
    this.inflight.add(guarded);
    void guarded.finally(() => this.inflight.delete(guarded));
  }

  private async process(path: string): Promise<void> {
    await this.primed;
    if (this.stopped) return;
    const probe = await this.host.probe(path);
    if (probe.type === "directory") {
      if (this.known.has(path)) await this.settle(path);
      await this.rescan(path);
      return;
    }
    await this.settle(path);
    // A folder that disappeared (deleted or moved away) only produces an event for itself.
    if (probe.type === "missing" && this.hasKnownBelow(path)) await this.rescan(path);
  }

  /** Settles every file below `prefix` whose on-disk state differs from what was reported. */
  private async rescan(prefix: string): Promise<void> {
    if (this.stopped) return;
    const current = await this.host.listFiles(prefix);
    const candidates = new Set<string>();
    for (const [path, version] of current) {
      if (this.known.get(path) !== version) candidates.add(path);
    }
    for (const path of this.known.keys()) {
      if (isUnderPrefix(path, prefix) && !current.has(path)) candidates.add(path);
    }
    for (const path of candidates) await this.settle(path);
  }

  private settle(path: string): Promise<void> {
    return this.host.withLock(path, async () => {
      if (this.stopped) return;
      const probe = await this.host.probe(path);
      const previous = this.known.get(path);
      if (probe.type === "file") {
        this.cancelDeleteConfirmation(path);
        if (previous === probe.version) return;
        this.known.set(path, probe.version);
        this.host.emit({
          kind: previous === undefined ? "created" : "modified",
          path,
          version: probe.version,
          self: false,
        });
        return;
      }
      if (previous === undefined) return;
      if (probe.type === "directory") {
        this.known.delete(path);
        this.host.emit({ kind: "deleted", path, self: false });
        return;
      }
      this.scheduleDeleteConfirmation(path);
    });
  }

  private scheduleDeleteConfirmation(path: string): void {
    if (this.deleteTimers.has(path) || this.stopped) return;
    const timer = setTimeout(() => {
      this.deleteTimers.delete(path);
      this.track(this.confirmDelete(path));
    }, this.options.deleteGraceMs);
    this.deleteTimers.set(path, timer);
  }

  private cancelDeleteConfirmation(path: string): void {
    const timer = this.deleteTimers.get(path);
    if (!timer) return;
    clearTimeout(timer);
    this.deleteTimers.delete(path);
  }

  private confirmDelete(path: string): Promise<void> {
    return this.host.withLock(path, async () => {
      if (this.stopped) return;
      const previous = this.known.get(path);
      if (previous === undefined) return;
      const probe = await this.host.probe(path);
      if (probe.type === "file") {
        if (probe.version === previous) return;
        this.known.set(path, probe.version);
        this.host.emit({ kind: "modified", path, version: probe.version, self: false });
        return;
      }
      this.known.delete(path);
      this.host.emit({ kind: "deleted", path, self: false });
    });
  }

  private hasKnownBelow(folder: string): boolean {
    const prefix = `${folder}/`;
    for (const path of this.known.keys()) if (path.startsWith(prefix)) return true;
    return false;
  }
}
