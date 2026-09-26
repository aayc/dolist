/**
 * One persisted file bound to a storage provider, applying the compatibility rules every owner
 * shares:
 *
 * - **Corrupt** (empty, not JSON, wrong shape, bad `version`): moved aside to
 *   `.daily-do-list/corrupt/…` with `rename` (the exact bytes survive, even invalid UTF-8), then
 *   treated as absent. If it cannot be moved, the file is never written this run.
 * - **Newer** `version` than this build knows: left untouched and never written (another device
 *   runs a newer app); the owner runs without it.
 * - **Partly invalid** (some list entries dropped): right before the first write that replaces
 *   it, the original is copied aside, so repairing the file never destroys evidence. If the copy
 *   fails, the file is never written this run.
 * - **Writes are conditional** on the version last read or written. A concurrent change (sync,
 *   another device, a hand edit) is re-read and re-classified: the owner may merge it
 *   (`onExternal`), a newer or unmovable file blocks writing, a corrupt one is moved aside.
 *
 * Structural storage interface so this module stays dependency-free; `StorageProvider` from
 * @ddl/storage satisfies it.
 */
import { errorMessage, type Logger, silentLogger } from "@ddl/core";
import type { PersistedDecodeResult, PersistedIssue } from "./common";
import { persistedQuarantinePath } from "./primitives";

export interface PersistedStorage {
  read(path: string): Promise<{ content: string; version: string } | null>;
  write(
    path: string,
    content: string,
    options?: { ifMatch?: string | null },
  ): Promise<{ version: string }>;
  rename(from: string, to: string): Promise<unknown>;
}

export type PersistedLoadResult<T> =
  | { status: "missing" }
  | { status: "loaded"; value: T; fromVersion: number | null; issues: PersistedIssue[] }
  | { status: "quarantined"; reason: string; movedTo: string | null }
  | { status: "newer"; version: number };

export type PersistedSaveResult = "written" | "blocked";

export interface PersistedFileOptions<T> {
  storage: PersistedStorage;
  path: string;
  decode(text: string): PersistedDecodeResult<T>;
  logger?: Logger;
  now?: () => number;
  /** What the caller already knows: a content version, or `null` for "does not exist". */
  known?: string | null;
}

/** Gave up after repeated concurrent modifications; the owner should retry later. */
export class PersistedWriteConflictError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`"${path}" kept changing while it was being saved`);
    this.name = "PersistedWriteConflictError";
    this.path = path;
  }
}

const MAX_SAVE_ATTEMPTS = 4;
const MAX_NAME_ATTEMPTS = 20;

export class PersistedFile<T> {
  readonly path: string;
  private readonly storage: PersistedStorage;
  private readonly decode: (text: string) => PersistedDecodeResult<T>;
  private readonly logger: Logger;
  private readonly now: () => number;
  /** Version on disk as last seen: string, `null` = absent, `undefined` = unknown (re-read). */
  private known: string | null | undefined;
  /** Content of a partly invalid file, copied aside before the write that replaces it. */
  private evidence: { content: string; issues: PersistedIssue[] } | null = null;
  private blockedReason: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PersistedFileOptions<T>) {
    this.path = options.path;
    this.storage = options.storage;
    this.decode = options.decode;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.known = options.known;
  }

  /**
   * Why this file is never written this run, as a phrase about the file ("was written by a newer
   * version of the app (format v2)"), or null.
   */
  get blocked(): string | null {
    return this.blockedReason;
  }

  /** Reads and classifies the file. Storage errors propagate; the state stays "unknown". */
  load(): Promise<PersistedLoadResult<T>> {
    return this.serialized(async () => {
      const file = await this.storage.read(this.path);
      if (!file) {
        this.known = null;
        return { status: "missing" } as const;
      }
      return this.accept(file);
    });
  }

  /**
   * Writes `render()` unless the file is blocked. On a concurrent change the current file is
   * re-read (passing a valid one to `onExternal` so the owner can merge it) and `render` runs
   * again. Storage errors propagate; after repeated conflicts `PersistedWriteConflictError`.
   */
  save(render: () => string, onExternal?: (value: T) => void): Promise<PersistedSaveResult> {
    return this.serialized(async () => {
      for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt++) {
        if (this.blockedReason !== null) return "blocked";
        if (this.known === undefined) {
          const file = await this.storage.read(this.path);
          if (!file) this.known = null;
          else {
            const result = await this.accept(file);
            if (result.status === "loaded") onExternal?.(result.value);
          }
          continue;
        }
        if (this.evidence && !(await this.preserveEvidence(this.evidence))) return "blocked";
        try {
          const written = await this.storage.write(this.path, render(), { ifMatch: this.known });
          this.known = written.version;
          return "written";
        } catch (error) {
          if (!hasName(error, "ConflictError")) throw error;
          this.known = undefined;
        }
      }
      throw new PersistedWriteConflictError(this.path);
    });
  }

  /** Moves the file aside although it decoded (e.g. it belongs to another owner). */
  quarantine(reason: string): Promise<string | null> {
    return this.serialized(() => this.moveAside(reason));
  }

  private async accept(file: {
    content: string;
    version: string;
  }): Promise<PersistedLoadResult<T>> {
    const decoded = this.decode(file.content);
    this.evidence = null;
    if (!decoded.ok) {
      if (decoded.kind === "newer") {
        this.block(`was written by a newer version of the app (format v${decoded.version})`);
        return { status: "newer", version: decoded.version };
      }
      const movedTo = await this.moveAside(decoded.reason);
      return { status: "quarantined", reason: decoded.reason, movedTo };
    }
    this.known = file.version;
    if (decoded.issues.length > 0) {
      this.evidence = { content: file.content, issues: decoded.issues };
      this.logger.warn("Ignoring invalid entries", {
        path: this.path,
        dropped: decoded.issues.length,
        entries: decoded.issues.slice(0, 5).map((issue) => issue.path),
      });
    }
    return {
      status: "loaded",
      value: decoded.value,
      fromVersion: decoded.fromVersion,
      issues: decoded.issues,
    };
  }

  private async moveAside(reason: string): Promise<string | null> {
    const at = new Date(this.now());
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
      const target = persistedQuarantinePath(this.path, at, attempt);
      try {
        await this.storage.rename(this.path, target);
        this.known = null;
        this.logger.warn("Moved an unreadable file aside", {
          path: this.path,
          movedTo: target,
          reason,
        });
        return target;
      } catch (error) {
        if (hasName(error, "ConflictError")) continue;
        if (hasName(error, "NotFoundError")) {
          this.known = null;
          return null;
        }
        this.block(`is unreadable (${reason}) and could not be moved aside`);
        this.logger.error("Could not move an unreadable file aside; it will not be overwritten", {
          path: this.path,
          reason,
          error: errorMessage(error),
        });
        return null;
      }
    }
    this.block(`is unreadable (${reason}) and no quarantine name was free`);
    return null;
  }

  private async preserveEvidence(evidence: {
    content: string;
    issues: PersistedIssue[];
  }): Promise<boolean> {
    const at = new Date(this.now());
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
      const target = persistedQuarantinePath(this.path, at, attempt);
      try {
        await this.storage.write(target, evidence.content, { ifMatch: null });
        this.evidence = null;
        this.logger.warn("Kept a copy of a partly invalid file before repairing it", {
          path: this.path,
          copiedTo: target,
          dropped: evidence.issues.length,
        });
        return true;
      } catch (error) {
        if (hasName(error, "ConflictError")) continue;
        this.block("could not be copied aside before repairing it");
        this.logger.error(
          "Could not keep a copy of a partly invalid file; it will not be rewritten",
          {
            path: this.path,
            error: errorMessage(error),
          },
        );
        return false;
      }
    }
    this.block("could not be copied aside before repairing it (no free name)");
    return false;
  }

  private block(reason: string): void {
    if (this.blockedReason !== null) return;
    this.blockedReason = reason;
    this.logger.warn("Not writing a file this run", { path: this.path, reason });
  }

  private serialized<R>(run: () => Promise<R>): Promise<R> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function hasName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
