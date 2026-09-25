import {
  hashString,
  type NoteResponse,
  type ParsedDrawingFile,
  parseDrawingFile,
  type WriteNoteRequest,
  type WriteNoteResponse,
} from "@ddl/core";
import { isNotFound } from "../../api/errors";

export interface DrawingsClient {
  readNote(path: string): Promise<NoteResponse>;
  /** Throws `ConflictError` (with the current file) when `baseVersion` is stale. */
  writeNote(path: string, body: WriteNoteRequest): Promise<WriteNoteResponse>;
}

/** A drawing file as last read or written. */
export interface DrawingDoc {
  readonly path: string;
  readonly text: string;
  readonly version: string;
  readonly parsed: ParsedDrawingFile;
  /** Of the text: what static renders are cached by. */
  readonly hash: string;
}

export type DrawingListener = (doc: DrawingDoc | null) => void;

function toDoc(path: string, text: string, version: string): DrawingDoc {
  return { path, text, version, parsed: parseDrawingFile(text), hash: hashString(text) };
}

/**
 * The drawing files the app shows, read and written through the notes API like any note (a
 * drawing is a note: `Excalidraw/<name>.excalidraw.md`). Embeds and editors subscribe to a path and
 * hear about every new version: their own saves, and changes from elsewhere.
 */
export class Drawings {
  private readonly client: DrawingsClient;
  private readonly docs = new Map<string, DrawingDoc>();
  private readonly loading = new Map<string, Promise<DrawingDoc>>();
  private readonly listeners = new Map<string, Set<DrawingListener>>();

  constructor(client: DrawingsClient) {
    this.client = client;
  }

  get(path: string): DrawingDoc | null {
    return this.docs.get(path) ?? null;
  }

  load(path: string): Promise<DrawingDoc> {
    const doc = this.docs.get(path);
    if (doc) return Promise.resolve(doc);
    let pending = this.loading.get(path);
    if (!pending) {
      pending = this.client
        .readNote(path)
        .then((note) => this.docs.get(path) ?? this.adopt(note))
        .finally(() => this.loading.delete(path));
      this.loading.set(path, pending);
    }
    return pending;
  }

  subscribe(path: string, listener: DrawingListener): () => void {
    let set = this.listeners.get(path);
    if (!set) {
      set = new Set();
      this.listeners.set(path, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(path) === set) this.listeners.delete(path);
    };
  }

  /** Takes a version read elsewhere (a 409's current file, a creation); tells listeners if new. */
  adopt(note: Pick<NoteResponse, "path" | "content" | "version">): DrawingDoc {
    const current = this.docs.get(note.path);
    if (current?.version === note.version) return current;
    const doc = toDoc(note.path, note.content, note.version);
    this.docs.set(note.path, doc);
    this.notify(note.path, doc);
    return doc;
  }

  /** Writes a new version over `baseVersion` (null: a new file). Throws `ConflictError`. */
  async write(path: string, text: string, baseVersion: string | null): Promise<DrawingDoc> {
    const response = await this.client.writeNote(path, { content: text, baseVersion });
    return this.adopt({ path: response.path, content: text, version: response.version });
  }

  /** A `vault.changed` from elsewhere touched `path`: re-read it if it's shown. */
  async handleRemoteChange(path: string, version?: string): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc && !this.listeners.has(path)) return;
    if (doc && version !== undefined && doc.version === version) return;
    try {
      this.adopt(await this.client.readNote(path));
    } catch (error) {
      if (isNotFound(error)) this.handleRemoteDelete(path);
    }
  }

  handleRemoteDelete(path: string): void {
    if (!this.docs.delete(path)) return;
    this.notify(path, null);
  }

  rename(from: string, to: string): void {
    for (const [path, doc] of [...this.docs]) {
      const next =
        path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
      if (next === null) continue;
      this.docs.delete(path);
      this.docs.set(next, { ...doc, path: next });
    }
  }

  private notify(path: string, doc: DrawingDoc | null): void {
    for (const listener of [...(this.listeners.get(path) ?? [])]) listener(doc);
  }
}
