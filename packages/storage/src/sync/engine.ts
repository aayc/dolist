import {
  type Debounced,
  debounce,
  errorMessage,
  type Logger,
  silentLogger,
  type Unsubscribe,
} from "@ddl/core";
import { isBinaryPath, isJournalPath, isMergeablePath, utf8ByteLength } from "../file-types";
import { IgnoreRules } from "../ignore-rules";
import {
  ConflictError,
  type FileContent,
  type FileEntry,
  type LeaseFence,
  StaleLeaseError,
  StorageError,
  type StorageEvent,
  type StorageProvider,
  type SyncReport,
  type SyncStatus,
  type SyncTargetConfig,
  type WriteResult,
} from "../types";
import { conflictCopyPath, isConflictCopyPath } from "./conflict-path";
import { decideSync, type SyncDecision } from "./decide";
import { mergeText } from "./diff3";
import { mergeJournals } from "./journal-merge";
import {
  emptySnapshot,
  parseSnapshot,
  type SnapshotEntry,
  SYNC_STATE_DIR,
  type SyncSnapshot,
  serializeSnapshot,
  snapshotPath,
} from "./snapshot";

export interface SyncEngineOptions {
  /** The vault. Also stores the sync snapshot. */
  primary: StorageProvider;
  /** Where the vault is mirrored (another folder, a bucket, …). */
  target: StorageProvider;
  logger?: Logger;
  /** Clock for timestamps and conflict-copy names. */
  now?: () => number;
  /** Extra vault-relative path prefixes that are never synced. */
  exclude?: string[];
  /**
   * Paths only the agent lease holder may change on the target (the sync service's agent files).
   * While this device doesn't hold the lease, or when the target refuses a change as made under
   * an earlier grant, the target's version of such a path wins: local changes are dropped, never
   * saved as a conflict copy. A local file the target never had stays here, unsent.
   */
  fence?: LeaseFence;
}

export interface SyncStartOptions {
  /** Full sync at least this often (catches target-side changes nobody reported). Default 30 s. */
  intervalMs?: number;
  /** Quiet period after a vault change before syncing. Default 1.5 s. */
  debounceMs?: number;
  /**
   * Quiet period after the target reports a change it didn't make itself (another device, another
   * app) before syncing. Short: such changes arrive already batched. Default 250 ms.
   */
  targetDebounceMs?: number;
}

/** A run refused to proceed because it would likely destroy data (e.g. the target looks wiped). */
export class SyncAbortedError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "SyncAbortedError";
  }
}

/** Largest text whose content is kept in the snapshot as a merge base. */
const MAX_BASE_BYTES = 256 * 1024;
const MAX_CONFLICT_NAME_ATTEMPTS = 50;

interface RunContext {
  snapshot: SyncSnapshot;
  primaryFiles: Map<string, FileEntry>;
  targetFiles: Map<string, FileEntry>;
  /** Paths that exist (or were created this run) on either side; conflict copies avoid them. */
  taken: Set<string>;
  report: SyncReport;
  deferred: Set<string>;
  failures: string[];
  dirtySnapshot: boolean;
}

/** Status for when no sync target is configured. */
export function disabledSyncStatus(): SyncStatus {
  return {
    state: "disabled",
    target: "none",
    lastSyncedAt: null,
    pendingChanges: 0,
    conflicts: [],
  };
}

/**
 * Provider-agnostic two-way sync between the vault (`primary`) and a `target` provider.
 *
 * Each run lists both sides and compares every path with the snapshot of the last synced state
 * (persisted in the primary at `.daily-do-list/sync/<target.id>.json`):
 * - changed on one side → copied to the other, with conditional writes (a concurrent edit makes
 *   the write fail and the path is retried next run);
 * - changed on both → identical content just updates the snapshot; markdown/text is merged line
 *   by line against the stored base (diff3); a conflicting merge keeps the vault's version and
 *   saves the target's as `<name> (conflict YYYY-MM-DD HHmm).<ext>` on both sides; the agent's
 *   journals are merged as a union of their lines (`mergeJournals`), never a conflict copy; other
 *   formats keep the newest (by mtime) and save the other as the conflict copy;
 * - deleted on one side and unchanged on the other → deleted there; deleted vs modified → the
 *   modified file is restored.
 * Binary files (images, PDFs, …) are skipped: the provider API is text-only.
 */
export class SyncEngine {
  private readonly primary: StorageProvider;
  private readonly target: StorageProvider;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly rules: IgnoreRules;
  private readonly fence: LeaseFence | undefined;
  private readonly snapshotFile: string;
  private readonly statusListeners = new Set<(status: SyncStatus) => void>();
  /** Paths changed in the vault since the current/last run started. */
  private readonly dirty = new Set<string>();
  /** Vault paths this engine is writing right now (their watch events are our own echo). */
  private readonly writingPrimary = new Set<string>();
  private deferred = new Set<string>();
  private snapshot: SyncSnapshot | undefined;
  private snapshotUnsaved = false;
  private current: SyncStatus;
  private running: Promise<SyncReport> | null = null;
  private queued: Promise<SyncReport> | null = null;
  private started:
    | {
        unwatch: Unsubscribe[];
        interval: ReturnType<typeof setInterval>;
        trigger: Debounced<[]>;
        targetTrigger: Debounced<[]>;
      }
    | undefined;

  constructor(options: SyncEngineOptions) {
    if (options.primary.id === options.target.id) {
      throw new StorageError("Sync target must be a different storage than the vault");
    }
    this.primary = options.primary;
    this.target = options.target;
    this.logger = (options.logger ?? silentLogger).child({
      component: "storage.sync",
      target: options.target.displayName,
    });
    this.now = options.now ?? Date.now;
    this.rules = new IgnoreRules([SYNC_STATE_DIR, ...(options.exclude ?? [])]);
    this.fence = options.fence;
    this.snapshotFile = snapshotPath(options.target.id);
    this.current = {
      state: "idle",
      target: targetKind(options.target),
      lastSyncedAt: null,
      pendingChanges: 0,
      conflicts: [],
    };
  }

  /** Runs one sync. Calls made during a run share a single follow-up run (runs never overlap). */
  syncOnce(): Promise<SyncReport> {
    if (!this.running) return this.launch();
    this.queued ??= this.running
      .catch(() => undefined)
      .then(() => {
        this.queued = null;
        return this.launch();
      });
    return this.queued;
  }

  /**
   * Syncs now, then after vault changes and changes the target reports from elsewhere (each
   * debounced), and on an interval, until `stop()`.
   */
  start(options: SyncStartOptions = {}): void {
    if (this.started) return;
    const trigger = debounce(() => this.syncInBackground(), options.debounceMs ?? 1_500);
    const targetTrigger = debounce(() => this.syncInBackground(), options.targetDebounceMs ?? 250);
    const interval = setInterval(() => this.syncInBackground(), options.intervalMs ?? 30_000);
    const unwatch = [this.primary.watch((event) => this.onPrimaryChange(event))];
    this.started = { unwatch, interval, trigger, targetTrigger };
    if (this.target.capabilities.watch) {
      try {
        unwatch.push(this.target.watch((event) => this.onTargetChange(event)));
      } catch (error) {
        this.logger.warn("cannot watch the sync target; relying on the interval", {
          error: errorMessage(error),
        });
      }
    }
    this.syncInBackground();
  }

  /** Stops automatic syncing and waits for an in-flight run to finish. */
  async stop(): Promise<void> {
    const started = this.started;
    this.started = undefined;
    if (started) {
      started.trigger.cancel();
      started.targetTrigger.cancel();
      clearInterval(started.interval);
      for (const unwatch of started.unwatch) unwatch();
    }
    while (this.queued || this.running) {
      await (this.queued ?? this.running)?.catch(() => undefined);
    }
  }

  status(): SyncStatus {
    return { ...this.current, conflicts: [...this.current.conflicts] };
  }

  onStatus(listener: (status: SyncStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  private launch(): Promise<SyncReport> {
    const run = this.run().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private syncInBackground(): void {
    this.syncOnce().catch((error: unknown) => {
      this.logger.warn("sync run failed", { error: errorMessage(error) });
    });
  }

  private onPrimaryChange(event: StorageEvent): void {
    if (this.writingPrimary.has(event.path) || !this.isSyncable(event.path)) return;
    this.dirty.add(event.path);
    this.setStatus({ pendingChanges: this.pendingCount() });
    this.started?.trigger();
  }

  /** Our own writes to the target (`self`) are already in the snapshot; nothing to do for them. */
  private onTargetChange(event: StorageEvent): void {
    if (event.self || !this.isSyncable(event.path)) return;
    this.dirty.add(event.path);
    this.setStatus({ pendingChanges: this.pendingCount() });
    this.started?.targetTrigger();
  }

  private async run(): Promise<SyncReport> {
    const startedAt = this.now();
    this.dirty.clear();
    this.setStatus({ state: "syncing" });
    try {
      const report = await this.reconcileAll();
      report.durationMs = Math.max(0, this.now() - startedAt);
      this.logger.debug("sync run finished", {
        pushed: report.pushed.length,
        pulled: report.pulled.length,
        deleted: report.deletedLocal.length + report.deletedRemote.length,
        merged: report.merged.length,
        conflicts: report.conflicts.length,
        durationMs: report.durationMs,
      });
      return report;
    } catch (error) {
      this.setStatus({
        state: "error",
        lastError: errorMessage(error),
        pendingChanges: this.pendingCount(),
      });
      throw error;
    }
  }

  private async reconcileAll(): Promise<SyncReport> {
    const snapshot = await this.loadSnapshot();
    const [primaryListing, targetListing] = await Promise.all([
      this.primary.list({ includeHidden: true }),
      this.target.list({ includeHidden: true }),
    ]);
    const primary = this.syncableFiles(primaryListing);
    const target = this.syncableFiles(targetListing);
    this.refuseMassDeletion(snapshot, primary, target);

    const ctx: RunContext = {
      snapshot,
      primaryFiles: primary.files,
      targetFiles: target.files,
      taken: new Set([...primary.files.keys(), ...target.files.keys()]),
      report: {
        pushed: [],
        pulled: [],
        deletedLocal: [],
        deletedRemote: [],
        merged: [],
        conflicts: [],
        durationMs: 0,
      },
      deferred: new Set(),
      failures: [],
      dirtySnapshot: false,
    };

    const paths = new Set([...primary.files.keys(), ...target.files.keys()]);
    for (const path of snapshot.entries.keys()) {
      if (this.isSyncable(path)) paths.add(path);
      else {
        snapshot.entries.delete(path);
        ctx.dirtySnapshot = true;
      }
    }
    for (const path of [...paths].sort()) {
      // Cloud placeholders (e.g. evicted iCloud files) are not deletions: wait for the download.
      if (primary.unavailable.has(path) || target.unavailable.has(path)) {
        ctx.deferred.add(path);
        continue;
      }
      try {
        await this.syncPath(path, ctx);
      } catch (error) {
        ctx.deferred.add(path);
        if (error instanceof ConflictError) {
          this.logger.debug("path changed during sync; retrying next run", { path });
        } else {
          ctx.failures.push(`${path}: ${errorMessage(error)}`);
          this.logger.warn("could not sync path", { path, error: errorMessage(error) });
        }
      }
    }

    for (const conflict of snapshot.conflicts) {
      if (
        !primary.files.has(conflict) &&
        !ctx.report.pulled.includes(conflict) &&
        !ctx.report.conflicts.some((c) => c.conflictPath === conflict)
      ) {
        snapshot.conflicts.delete(conflict);
        ctx.dirtySnapshot = true;
      }
    }
    if (ctx.dirtySnapshot || this.snapshotUnsaved) {
      // Stays set if the write throws, so a later run retries even when nothing else changed.
      this.snapshotUnsaved = true;
      await this.saveSnapshot(snapshot);
      this.snapshotUnsaved = false;
    }

    this.deferred = ctx.deferred;
    this.setStatus({
      state: "idle",
      lastSyncedAt: this.now(),
      pendingChanges: this.pendingCount(),
      conflicts: [...snapshot.conflicts].sort(),
      lastError:
        ctx.failures.length > 0
          ? `Could not sync ${ctx.failures.length} file(s): ${ctx.failures[0]}`
          : undefined,
    });
    return ctx.report;
  }

  private async syncPath(path: string, ctx: RunContext): Promise<void> {
    const base = ctx.snapshot.entries.get(path);
    const decision = decideSync(base, ctx.primaryFiles.get(path), ctx.targetFiles.get(path));
    if (this.fence?.covers(path)) {
      await this.syncFencedPath(path, decision, base, ctx);
      return;
    }
    switch (decision.action) {
      case "skip":
        return;
      case "forget":
        ctx.snapshot.entries.delete(path);
        ctx.dirtySnapshot = true;
        return;
      case "push": {
        const source = await this.readOrDefer(this.primary, path);
        const written = await this.target.write(path, source.content, {
          ifMatch: decision.target?.version ?? null,
        });
        this.record(ctx, path, source.version, written.version, source.content);
        ctx.report.pushed.push(path);
        return;
      }
      case "pull": {
        const source = await this.readOrDefer(this.target, path);
        const written = await this.writePrimary(
          path,
          source.content,
          decision.primary?.version ?? null,
        );
        this.record(ctx, path, written.version, source.version, source.content);
        ctx.report.pulled.push(path);
        // Another device resolved a conflict: its copy is this device's to review too.
        if (!decision.primary && isConflictCopyPath(path)) ctx.snapshot.conflicts.add(path);
        return;
      }
      case "delete-target":
        await this.target.delete(path, { ifMatch: decision.target.version });
        this.forget(ctx, path);
        ctx.report.deletedRemote.push(path);
        return;
      case "delete-primary":
        await this.deletePrimary(path, decision.primary.version);
        this.forget(ctx, path);
        ctx.report.deletedLocal.push(path);
        return;
      case "reconcile":
        await this.reconcile(path, base, ctx);
        return;
    }
  }

  private async reconcile(
    path: string,
    base: SnapshotEntry | undefined,
    ctx: RunContext,
  ): Promise<void> {
    const [ours, theirs] = await Promise.all([
      this.readOrDefer(this.primary, path),
      this.readOrDefer(this.target, path),
    ]);
    if (ours.content === theirs.content) {
      this.record(ctx, path, ours.version, theirs.version, ours.content);
      return;
    }
    if (isJournalPath(path)) {
      await this.mergeJournal(path, ours, theirs, ctx);
      return;
    }
    if (base?.b !== undefined && isMergeablePath(path)) {
      const merged = mergeText(base.b, ours.content, theirs.content, { unionInsertions: true });
      if (merged.clean) {
        const primaryVersion =
          merged.text === ours.content
            ? ours.version
            : (await this.writePrimary(path, merged.text, ours.version)).version;
        const targetVersion =
          merged.text === theirs.content
            ? theirs.version
            : (await this.target.write(path, merged.text, { ifMatch: theirs.version })).version;
        this.record(ctx, path, primaryVersion, targetVersion, merged.text);
        ctx.report.merged.push(path);
        return;
      }
    }
    await this.resolveConflict(path, ours, theirs, ctx);
  }

  /**
   * A path only the lease holder may change on the target. Pulls work as usual. The holder pushes
   * its version (it is the authority: no merge, no conflict copy); anyone else, or a holder whose
   * grant the target no longer accepts, takes the target's version.
   */
  private async syncFencedPath(
    path: string,
    decision: SyncDecision,
    base: SnapshotEntry | undefined,
    ctx: RunContext,
  ): Promise<void> {
    switch (decision.action) {
      case "skip":
        return;
      case "forget":
        this.forget(ctx, path);
        return;
      case "pull": {
        const source = await this.readOrDefer(this.target, path);
        const written = await this.writePrimary(
          path,
          source.content,
          decision.primary?.version ?? null,
        );
        this.record(ctx, path, written.version, source.version, source.content);
        ctx.report.pulled.push(path);
        return;
      }
      case "delete-primary":
        await this.deletePrimary(path, decision.primary.version);
        this.forget(ctx, path);
        ctx.report.deletedLocal.push(path);
        return;
    }
    if (this.fence?.epoch() === null) {
      await this.yieldToTarget(path, base, ctx);
      return;
    }
    try {
      if (decision.action === "delete-target") {
        await this.target.delete(path, { ifMatch: decision.target.version });
        this.forget(ctx, path);
        ctx.report.deletedRemote.push(path);
        return;
      }
      const ours = await this.readOrDefer(this.primary, path);
      let ifMatch = decision.target?.version ?? null;
      let content = ours.content;
      let primaryVersion = ours.version;
      if (decision.action === "reconcile") {
        const current = await this.readOrDefer(this.target, path);
        if (current.content === ours.content) {
          this.record(ctx, path, ours.version, current.version, ours.content);
          return;
        }
        ifMatch = current.version;
        // A journal keeps every event either side has, even under the holder's authority.
        if (isJournalPath(path)) {
          content = mergeJournals(ours.content, current.content);
          if (content !== ours.content) {
            primaryVersion = (await this.writePrimary(path, content, ours.version)).version;
          }
        }
      }
      const written = await this.target.write(path, content, { ifMatch });
      this.record(ctx, path, primaryVersion, written.version, content);
      ctx.report.pushed.push(path);
    } catch (error) {
      if (!(error instanceof StaleLeaseError)) throw error;
      this.logger.warn("agent file refused: this device no longer holds the agent lease", { path });
      await this.yieldToTarget(path, base, ctx);
    }
  }

  /** Makes the vault's copy of a fenced path the target's; one the target never had stays here. */
  private async yieldToTarget(
    path: string,
    base: SnapshotEntry | undefined,
    ctx: RunContext,
  ): Promise<void> {
    const ours = ctx.primaryFiles.get(path);
    const theirs = await this.target.read(path);
    if (theirs) {
      const current = ours ? await this.primary.read(path) : null;
      if (current?.content !== theirs.content) {
        const written = await this.writePrimary(path, theirs.content, current?.version ?? null);
        this.record(ctx, path, written.version, theirs.version, theirs.content);
        ctx.report.pulled.push(path);
        this.logger.warn("dropped this device's changes to an agent file for the lease holder's", {
          path,
        });
      } else {
        this.record(ctx, path, current.version, theirs.version, theirs.content);
      }
      return;
    }
    if (ours && base) {
      await this.deletePrimary(path, ours.version);
      this.forget(ctx, path);
      ctx.report.deletedLocal.push(path);
      this.logger.warn("dropped an agent file the lease holder deleted", { path });
      return;
    }
    if (!ours && base) this.forget(ctx, path);
  }

  /** An agent journal changed on both sides: both get the union of its lines, never a copy. */
  private async mergeJournal(
    path: string,
    ours: FileContent,
    theirs: FileContent,
    ctx: RunContext,
  ): Promise<void> {
    const merged = mergeJournals(ours.content, theirs.content);
    const primaryVersion =
      merged === ours.content
        ? ours.version
        : (await this.writePrimary(path, merged, ours.version)).version;
    const targetVersion =
      merged === theirs.content
        ? theirs.version
        : (await this.target.write(path, merged, { ifMatch: theirs.version })).version;
    this.record(ctx, path, primaryVersion, targetVersion, merged);
    ctx.report.merged.push(path);
  }

  /** Text keeps the vault's version; other formats keep the newest. The other becomes a copy. */
  private async resolveConflict(
    path: string,
    ours: FileContent,
    theirs: FileContent,
    ctx: RunContext,
  ): Promise<void> {
    const keepPrimary = isMergeablePath(path) || ours.mtime >= theirs.mtime;
    const conflictPath = await this.writeConflictCopy(
      path,
      keepPrimary ? theirs.content : ours.content,
      ctx,
    );
    if (keepPrimary) {
      const written = await this.target.write(path, ours.content, { ifMatch: theirs.version });
      this.record(ctx, path, ours.version, written.version, ours.content);
    } else {
      const written = await this.writePrimary(path, theirs.content, ours.version);
      this.record(ctx, path, written.version, theirs.version, theirs.content);
    }
    ctx.report.conflicts.push({ path, conflictPath });
  }

  private async writeConflictCopy(path: string, content: string, ctx: RunContext): Promise<string> {
    const at = new Date(this.now());
    for (let attempt = 1; attempt <= MAX_CONFLICT_NAME_ATTEMPTS; attempt++) {
      const candidate = conflictCopyPath(path, at, attempt);
      if (ctx.taken.has(candidate)) continue;
      ctx.taken.add(candidate);
      let inVault: WriteResult;
      try {
        inVault = await this.writePrimary(candidate, content, null);
      } catch (error) {
        if (error instanceof ConflictError) continue;
        throw error;
      }
      ctx.snapshot.conflicts.add(candidate);
      ctx.dirtySnapshot = true;
      try {
        const inTarget = await this.target.write(candidate, content, { ifMatch: null });
        this.record(ctx, candidate, inVault.version, inTarget.version, content);
      } catch (error) {
        // The copy is safe in the vault; the next run pushes (or reconciles) it.
        this.logger.warn("could not copy conflict file to target", {
          path: candidate,
          error: errorMessage(error),
        });
      }
      return candidate;
    }
    throw new StorageError(`No free name for a conflict copy of "${path}"`, path);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async readOrDefer(provider: StorageProvider, path: string): Promise<FileContent> {
    const file = await provider.read(path);
    // Vanished since the listing: treat like a concurrent edit and look again next run.
    if (!file) throw new ConflictError(path, null);
    return file;
  }

  private async writePrimary(
    path: string,
    content: string,
    ifMatch: string | null,
  ): Promise<WriteResult> {
    this.writingPrimary.add(path);
    try {
      return await this.primary.write(path, content, { ifMatch });
    } finally {
      this.writingPrimary.delete(path);
    }
  }

  private async deletePrimary(path: string, ifMatch: string): Promise<void> {
    this.writingPrimary.add(path);
    try {
      await this.primary.delete(path, { ifMatch });
    } finally {
      this.writingPrimary.delete(path);
    }
  }

  private record(ctx: RunContext, path: string, p: string, t: string, content: string): void {
    const entry: SnapshotEntry = { p, t };
    if (isMergeablePath(path) && utf8ByteLength(content) <= MAX_BASE_BYTES) entry.b = content;
    ctx.snapshot.entries.set(path, entry);
    ctx.dirtySnapshot = true;
  }

  private forget(ctx: RunContext, path: string): void {
    ctx.snapshot.entries.delete(path);
    ctx.dirtySnapshot = true;
  }

  private isSyncable(path: string): boolean {
    return !this.rules.isIgnored(path) && !isBinaryPath(path);
  }

  private syncableFiles(listing: FileEntry[]): SideListing {
    const files = new Map<string, FileEntry>();
    const unavailable = new Set<string>();
    for (const entry of listing) {
      const placeholderFor = cloudPlaceholderTarget(entry.path);
      if (placeholderFor) unavailable.add(placeholderFor);
      else if (this.isSyncable(entry.path)) files.set(entry.path, entry);
    }
    return { files, unavailable };
  }

  /**
   * An unmounted drive or a wiped/unsynced cloud folder lists as empty. Propagating that would
   * delete every note on the other side, so refuse whenever an empty side would delete synced
   * files that are unchanged on the other (edited ones would be restored, not deleted).
   */
  private refuseMassDeletion(
    snapshot: SyncSnapshot,
    primary: SideListing,
    target: SideListing,
  ): void {
    if (snapshot.entries.size === 0) return;
    if (target.files.size === 0 && primary.files.size > 0) {
      const doomed = doomedBy(snapshot, primary.files, "p", target.unavailable);
      if (doomed > 0) {
        throw new SyncAbortedError(
          `Sync target "${this.target.displayName}" is empty; refusing to delete ${doomed} synced file(s) from the vault. Make sure it is available, or remove ${this.snapshotFile} to start over.`,
        );
      }
    }
    if (primary.files.size === 0 && target.files.size > 0) {
      const doomed = doomedBy(snapshot, target.files, "t", primary.unavailable);
      if (doomed > 0) {
        throw new SyncAbortedError(
          `The vault is empty; refusing to delete ${doomed} synced file(s) from "${this.target.displayName}". Remove ${this.snapshotFile} to start over.`,
        );
      }
    }
  }

  private async loadSnapshot(): Promise<SyncSnapshot> {
    if (this.snapshot) return this.snapshot;
    const file = await this.primary.read(this.snapshotFile);
    const parsed = file ? parseSnapshot(file.content, this.target.id) : null;
    if (file && !parsed) {
      this.logger.warn(
        "ignoring unreadable sync snapshot; files present on both sides will be compared",
        {
          path: this.snapshotFile,
        },
      );
    }
    this.snapshot = parsed ?? emptySnapshot();
    return this.snapshot;
  }

  private async saveSnapshot(snapshot: SyncSnapshot): Promise<void> {
    const json = serializeSnapshot(this.target.id, snapshot, this.now());
    this.writingPrimary.add(this.snapshotFile);
    try {
      await this.primary.write(this.snapshotFile, json);
    } finally {
      this.writingPrimary.delete(this.snapshotFile);
    }
  }

  private pendingCount(): number {
    let count = this.deferred.size;
    for (const path of this.dirty) if (!this.deferred.has(path)) count++;
    return count;
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    const next: SyncStatus = { ...this.current, ...patch };
    if (next.lastError === undefined) delete next.lastError;
    this.current = next;
    const snapshot = this.status();
    for (const listener of [...this.statusListeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.error("sync status listener threw", { error: errorMessage(error) });
      }
    }
  }
}

interface SideListing {
  files: Map<string, FileEntry>;
  /** Paths present only as cloud placeholders: waiting for a download, not deleted. */
  unavailable: Set<string>;
}

/** Synced files on the listed side that an empty other side would get deleted. */
function doomedBy(
  snapshot: SyncSnapshot,
  files: Map<string, FileEntry>,
  side: "p" | "t",
  unavailableOnEmptySide: Set<string>,
): number {
  let doomed = 0;
  for (const [path, entry] of snapshot.entries) {
    if (!unavailableOnEmptySide.has(path) && files.get(path)?.version === entry[side]) doomed++;
  }
  return doomed;
}

function targetKind(target: StorageProvider): SyncTargetConfig["kind"] {
  return target.kind === "remote" ? "remote" : "local";
}

/** `Daily/.note.md.icloud` (an evicted iCloud Drive file) → `Daily/note.md`. */
function cloudPlaceholderTarget(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const match = /^\.(.+)\.icloud$/.exec(name);
  if (!match) return null;
  return `${path.slice(0, slash + 1)}${match[1]}`;
}
