import {
  dirname,
  type NoteResponse,
  stem,
  type WriteNoteRequest,
  type WriteNoteResponse,
} from "@ddl/core";
import type { WriteOptions } from "../api/client";
import { ConflictError, isNotFound } from "../api/errors";
import type { SaveState } from "./notes-store";

export interface NotesClient {
  readNote(path: string): Promise<NoteResponse>;
  writeNote(
    path: string,
    body: WriteNoteRequest,
    options?: WriteOptions,
  ): Promise<WriteNoteResponse>;
}

export interface NotesControllerHooks {
  /** Current editor content of `path` if it is the note shown in the editor, else null. */
  readLive(path: string): string | null;
  /** A newer version arrived and there were no local edits: show it. */
  applyRemote(path: string, content: string): void;
  onSaveState(path: string, state: SaveState | null): void;
  /** Local edits won a conflict; the other version was preserved as `copyPath`. */
  onConflictCopy(path: string, copyPath: string): void;
  /** The note was deleted elsewhere. `restored`: local edits were written back. */
  onRemoteDelete(path: string, restored: boolean): void;
  onSaveError(path: string, error: unknown): void;
  pathExists(path: string): boolean;
}

export interface NotesControllerOptions {
  client: NotesClient;
  hooks: NotesControllerHooks;
  /** Quiet period after the last edit before autosaving. */
  saveDelayMs?: number;
  retryDelayMs?: number;
}

interface NoteDoc {
  path: string;
  /** Content as of `version` on the server. */
  serverContent: string;
  version: string;
  mtime: number;
  /** Incremented per local edit; `savedRev` is the last revision the server acknowledged. */
  localRev: number;
  savedRev: number;
  /** Local content captured when the note left the editor with unsaved edits. */
  pendingContent: string | null;
  lastEdit: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  inflight: Promise<void> | null;
  resave: boolean;
  recheck: boolean;
  conflict: boolean;
  failed: boolean;
  failures: number;
  status: SaveState | null;
}

/**
 * Owns persistence of open notes: debounced autosave with optimistic concurrency (`baseVersion`),
 * single-flight writes per note, conflict resolution and external-change handling. The editor stays
 * uncontrolled: content is only read (via `readLive`) when a save actually happens.
 */
export class NotesController {
  private readonly client: NotesClient;
  private readonly hooks: NotesControllerHooks;
  private readonly saveDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly docs = new Map<string, NoteDoc>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(options: NotesControllerOptions) {
    this.client = options.client;
    this.hooks = options.hooks;
    this.saveDelayMs = options.saveDelayMs ?? 300;
    this.retryDelayMs = options.retryDelayMs ?? 2000;
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  paths(): string[] {
    return [...this.docs.keys()];
  }

  serverContent(path: string): string | null {
    return this.docs.get(path)?.serverContent ?? null;
  }

  version(path: string): string | null {
    return this.docs.get(path)?.version ?? null;
  }

  isDirty(path: string): boolean {
    const doc = this.docs.get(path);
    return doc !== undefined && doc.localRev !== doc.savedRev;
  }

  /** Dirty or mid-save: must not be evicted or overwritten. */
  isBusy(path: string): boolean {
    const doc = this.docs.get(path);
    return doc !== undefined && (doc.localRev !== doc.savedRev || doc.inflight !== null);
  }

  load(path: string): Promise<void> {
    if (this.docs.has(path)) return Promise.resolve();
    const pending = this.loading.get(path);
    if (pending) return pending;
    const promise = this.client
      .readNote(path)
      .then((note) => this.adopt(note))
      .finally(() => this.loading.delete(path));
    this.loading.set(path, promise);
    return promise;
  }

  /** Registers a note fetched elsewhere (e.g. the daily-note endpoint). Never clobbers local edits. */
  adopt(note: NoteResponse): void {
    const doc = this.docs.get(note.path);
    if (!doc) {
      const created = this.createDoc(note);
      this.docs.set(note.path, created);
      this.updateStatus(created);
      return;
    }
    if (doc.version === note.version || this.isBusy(note.path)) return;
    doc.serverContent = note.content;
    doc.version = note.version;
    doc.mtime = note.mtime;
    this.hooks.applyRemote(note.path, note.content);
  }

  /** Called for every local edit. O(1): no content is read here. */
  markDirty(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    doc.localRev++;
    doc.lastEdit = performance.now();
    this.updateStatus(doc);
    this.arm(doc, this.saveDelayMs);
  }

  flush(path: string, options: WriteOptions = {}): Promise<void> {
    const doc = this.docs.get(path);
    return doc ? this.save(doc, options) : Promise.resolve();
  }

  async flushAll(options: WriteOptions = {}): Promise<void> {
    await Promise.all([...this.docs.values()].map((doc) => this.save(doc, options)));
  }

  /** A `vault.changed` from someone else touched `path`. */
  async handleRemoteChange(path: string, version?: string): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc || (version !== undefined && version === doc.version)) return;
    if (doc.inflight) {
      doc.recheck = true;
      return;
    }
    let fresh: NoteResponse;
    try {
      fresh = await this.client.readNote(path);
    } catch (error) {
      if (isNotFound(error)) this.handleRemoteDelete(path);
      return;
    }
    if (this.docs.get(path) !== doc || fresh.version === doc.version) return;
    if (doc.inflight) {
      doc.recheck = true;
      return;
    }
    if (doc.localRev === doc.savedRev) {
      doc.serverContent = fresh.content;
      doc.version = fresh.version;
      doc.mtime = fresh.mtime;
      this.hooks.applyRemote(path, fresh.content);
      return;
    }
    // Local edits pending: the next save gets a 409 and resolves the conflict.
    doc.conflict = true;
    this.updateStatus(doc);
    this.arm(doc, this.saveDelayMs);
  }

  handleRemoteDelete(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    if (this.isBusy(path)) {
      doc.conflict = true;
      this.updateStatus(doc);
      this.arm(doc, this.saveDelayMs);
      return;
    }
    this.forget(path);
    this.hooks.onRemoteDelete(path, false);
  }

  /** Moves bookkeeping after a rename of a note (or of a folder containing notes). */
  rename(from: string, to: string): void {
    for (const doc of [...this.docs.values()]) {
      let next: string | null = null;
      if (doc.path === from) next = to;
      else if (doc.path.startsWith(`${from}/`)) next = `${to}${doc.path.slice(from.length)}`;
      if (next === null) continue;
      this.docs.delete(doc.path);
      this.hooks.onSaveState(doc.path, null);
      doc.path = next;
      doc.status = null;
      this.docs.set(next, doc);
      this.updateStatus(doc);
    }
  }

  forget(path: string): void {
    const doc = this.docs.get(path);
    if (!doc) return;
    if (doc.timer !== undefined) clearTimeout(doc.timer);
    this.docs.delete(path);
    this.hooks.onSaveState(path, null);
  }

  private createDoc(note: NoteResponse): NoteDoc {
    return {
      path: note.path,
      serverContent: note.content,
      version: note.version,
      mtime: note.mtime,
      localRev: 0,
      savedRev: 0,
      pendingContent: null,
      lastEdit: 0,
      timer: undefined,
      inflight: null,
      resave: false,
      recheck: false,
      conflict: false,
      failed: false,
      failures: 0,
      status: null,
    };
  }

  /** One timer per note, re-armed from the last edit time instead of being reset per keystroke. */
  private arm(doc: NoteDoc, delay: number): void {
    if (doc.timer !== undefined) return;
    doc.timer = setTimeout(() => {
      doc.timer = undefined;
      const idle = performance.now() - doc.lastEdit;
      if (idle < this.saveDelayMs) {
        this.arm(doc, this.saveDelayMs - idle);
        return;
      }
      void this.save(doc);
    }, delay);
  }

  private save(doc: NoteDoc, options: WriteOptions = {}): Promise<void> {
    if (doc.timer !== undefined) {
      clearTimeout(doc.timer);
      doc.timer = undefined;
    }
    const live = this.hooks.readLive(doc.path);
    if (live !== null) doc.pendingContent = live;
    if (doc.inflight) {
      if (doc.localRev === doc.savedRev) return doc.inflight;
      doc.resave = true;
      // Settles with the follow-up write that carries these edits (started when this one ends).
      return doc.inflight.then(() => doc.inflight ?? undefined);
    }
    if (doc.localRev === doc.savedRev) return Promise.resolve();

    const content = doc.pendingContent ?? doc.serverContent;
    const rev = doc.localRev;
    const run = this.write(doc, content, rev, options, 0).finally(() => {
      doc.inflight = null;
      if (!this.tracks(doc)) return;
      this.updateStatus(doc);
      if (doc.recheck) {
        doc.recheck = false;
        void this.handleRemoteChange(doc.path);
      }
      if (doc.localRev !== doc.savedRev && !doc.failed) {
        if (doc.resave) {
          doc.resave = false;
          void this.save(doc);
        } else {
          this.arm(doc, this.saveDelayMs);
        }
      }
    });
    doc.inflight = run;
    this.updateStatus(doc);
    return run;
  }

  private async write(
    doc: NoteDoc,
    content: string,
    rev: number,
    options: WriteOptions,
    depth: number,
  ): Promise<void> {
    try {
      const res = await this.client.writeNote(
        doc.path,
        { content, baseVersion: doc.version },
        options,
      );
      this.acknowledge(doc, content, rev, res.version, res.mtime);
    } catch (error) {
      // Forgotten meanwhile (deleted, closed): resolving a 409 would recreate a deleted note.
      if (!this.tracks(doc)) return;
      if (!(error instanceof ConflictError) || depth >= 3) {
        this.fail(doc, error);
        return;
      }
      try {
        await this.resolveConflict(doc, content, rev, error.current, options, depth);
      } catch (inner) {
        this.fail(doc, inner);
      }
    }
  }

  private async resolveConflict(
    doc: NoteDoc,
    content: string,
    rev: number,
    current: NoteResponse | null,
    options: WriteOptions,
    depth: number,
  ): Promise<void> {
    if (current === null) {
      const res = await this.client.writeNote(doc.path, { content, baseVersion: null }, options);
      this.acknowledge(doc, content, rev, res.version, res.mtime);
      this.hooks.onRemoteDelete(doc.path, true);
      return;
    }
    if (current.content === content) {
      this.acknowledge(doc, content, rev, current.version, current.mtime);
      return;
    }
    const hasLocalEdits = content !== doc.serverContent || doc.localRev !== rev;
    if (!hasLocalEdits) {
      doc.serverContent = current.content;
      doc.version = current.version;
      doc.mtime = current.mtime;
      doc.savedRev = doc.localRev;
      doc.pendingContent = null;
      doc.conflict = false;
      this.hooks.applyRemote(doc.path, current.content);
      return;
    }
    const copyPath = await this.writeConflictCopy(doc.path, current.content);
    this.hooks.onConflictCopy(doc.path, copyPath);
    if (!this.tracks(doc)) return;
    doc.version = current.version;
    await this.write(doc, content, rev, options, depth + 1);
  }

  private async writeConflictCopy(path: string, content: string): Promise<string> {
    const folder = dirname(path);
    const base = stem(path);
    for (let n = 1; n <= 20; n++) {
      const name = n === 1 ? `${base} (conflict).md` : `${base} (conflict ${n}).md`;
      const candidate = folder ? `${folder}/${name}` : name;
      if (this.hooks.pathExists(candidate)) continue;
      try {
        await this.client.writeNote(candidate, { content, baseVersion: null });
        return candidate;
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
      }
    }
    throw new Error(`Could not save a conflict copy of ${path}`);
  }

  private acknowledge(doc: NoteDoc, content: string, rev: number, version: string, mtime: number) {
    doc.version = version;
    doc.mtime = mtime;
    doc.serverContent = content;
    doc.savedRev = Math.max(doc.savedRev, rev);
    doc.conflict = false;
    doc.failed = false;
    doc.failures = 0;
    if (doc.savedRev === doc.localRev) doc.pendingContent = null;
  }

  /** False once the note was forgotten (or replaced by a reload); late results are dropped. */
  private tracks(doc: NoteDoc): boolean {
    return this.docs.get(doc.path) === doc;
  }

  private fail(doc: NoteDoc, error: unknown): void {
    if (!this.tracks(doc)) return;
    doc.failed = true;
    doc.failures++;
    this.hooks.onSaveError(doc.path, error);
    const delay = Math.min(30_000, this.retryDelayMs * 2 ** (doc.failures - 1));
    setTimeout(() => {
      if (!this.tracks(doc) || doc.localRev === doc.savedRev) return;
      doc.failed = false;
      void this.save(doc);
    }, delay);
  }

  private updateStatus(doc: NoteDoc): void {
    const next: SaveState = doc.conflict
      ? "conflict"
      : doc.inflight
        ? "saving"
        : doc.failed
          ? "error"
          : doc.localRev !== doc.savedRev
            ? "dirty"
            : "saved";
    if (next === doc.status) return;
    doc.status = next;
    this.hooks.onSaveState(doc.path, next);
  }
}
