import {
  type DrawingBinaryFiles,
  type DrawingElement,
  DrawingUnreadableError,
  mergeDrawingElements,
  mergeDrawingFiles,
  serializeDrawingFile,
} from "@ddl/core";
import { ConflictError } from "../../api/errors";
import type { DrawingDoc, Drawings } from "./drawing-store";
import { ElementIds } from "./element-ids";
import { type EditorScene, editKey, sceneForFile } from "./scene";

/** What a session needs from the editor showing the drawing (Excalidraw, or a fake in tests). */
export interface DrawingEditorPort {
  /** Everything the editor holds now, deleted elements included. */
  scene(): EditorScene;
  /** Replaces the editor's elements and images with a merge, outside its undo history. */
  replace(elements: DrawingElement[], files: DrawingBinaryFiles): void;
  /** Elements being edited this moment (a text being typed): a merge keeps their local copy. */
  editing(): ReadonlySet<string>;
}

export interface DrawingSessionOptions {
  drawings: Drawings;
  doc: DrawingDoc;
  saveDelayMs?: number;
  onError?(error: unknown): void;
}

const MAX_CONFLICT_RETRIES = 3;

/**
 * One drawing open in an editor: saves its edits, debounced like notes, over the version it
 * started from (`baseVersion`), and merges newer versions from elsewhere into the editor (a 409, or
 * a change pushed while editing) element by element, so neither side's work is lost. The file
 * keeps what the editor doesn't know about (`serializeDrawingFile` with the previous file), and a
 * file it can't read is never written over.
 */
export class DrawingSession {
  readonly path: string;
  private readonly drawings: Drawings;
  private readonly saveDelayMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly ids = new ElementIds();
  private base: DrawingDoc;
  /** What the next save writes over; null once the file was deleted elsewhere (it's recreated). */
  private baseVersion: string | null;
  private editor: DrawingEditorPort | null = null;
  /** `editKey` of what the file holds; the editor differs from it while it has unsaved edits. */
  private cleanKey = "";
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | null = null;
  private remote: DrawingDoc | null = null;
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(options: DrawingSessionOptions) {
    this.drawings = options.drawings;
    this.base = options.doc;
    this.baseVersion = options.doc.version;
    this.path = options.doc.path;
    this.saveDelayMs = options.saveDelayMs ?? 500;
    this.onError = options.onError ?? (() => {});
    this.unsubscribe = this.drawings.subscribe(this.path, (doc) => {
      if (doc && doc.version !== this.base.version) this.receive(doc);
    });
  }

  /** The drawing as the editor should start with it (editor ids). */
  initialScene(): EditorScene {
    const { scene } = this.base.parsed;
    return {
      elements: this.ids.local(scene.elements),
      appState: scene.appState,
      files: scene.files,
    };
  }

  /** Whether the file can be edited: an unreadable one is shown read-only, never saved over. */
  get readable(): boolean {
    return this.base.parsed.readable;
  }

  get hasUnsavedEdits(): boolean {
    return this.dirty || this.inflight !== null;
  }

  /** The editor is ready; what it shows now is the file (loading may have normalized it). */
  attach(editor: DrawingEditorPort): void {
    this.editor = editor;
    const { elements, appState } = editor.scene();
    this.cleanKey = editKey(elements, appState);
    if (this.remote) this.receive(this.remote);
  }

  /** The editor changed (Excalidraw's `onChange`, which also fires for mere re-renders). */
  changed(elements: readonly DrawingElement[], appState: Readonly<Record<string, unknown>>): void {
    if (!this.editor || this.closed || !this.readable) return;
    if (editKey(elements, appState) === this.cleanKey) return;
    this.dirty = true;
    this.arm();
  }

  /** Saves now (ending an edit, leaving the page). */
  async flush(): Promise<void> {
    this.disarm();
    while (this.inflight) await this.inflight;
    if (this.dirty) await this.save();
  }

  /** Flushes, then stops listening. */
  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.closed = true;
      this.unsubscribe();
      this.editor = null;
    }
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.save();
    }, this.saveDelayMs);
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private save(): Promise<void> {
    if (this.inflight) return this.inflight;
    const run = this.write(0).finally(() => {
      this.inflight = null;
      if (this.remote) this.receive(this.remote);
      if (this.dirty && !this.closed) this.arm();
    });
    this.inflight = run;
    return run;
  }

  private async write(attempt: number): Promise<void> {
    const editor = this.editor;
    if (!editor || !this.dirty) return;
    this.dirty = false;
    const { elements, appState, files } = editor.scene();
    const key = editKey(elements, appState);
    let text: string;
    try {
      text = serializeDrawingFile(
        sceneForFile(this.ids.file(elements), appState, files),
        this.base.parsed,
      );
    } catch (error) {
      if (!(error instanceof DrawingUnreadableError)) this.dirty = true;
      this.onError(error);
      return;
    }
    if (text === this.base.text) {
      this.cleanKey = key;
      return;
    }
    try {
      this.base = await this.drawings.write(this.path, text, this.baseVersion);
      this.baseVersion = this.base.version;
      this.cleanKey = key;
    } catch (error) {
      this.dirty = true;
      if (!(error instanceof ConflictError) || attempt >= MAX_CONFLICT_RETRIES) {
        this.onError(error);
        return;
      }
      if (error.current) this.merge(this.drawings.adopt(error.current));
      else this.baseVersion = null;
      await this.write(attempt + 1);
    }
  }

  /** A newer version of the file: merged into the editor unless a save is in flight (then after). */
  private receive(doc: DrawingDoc): void {
    if (doc.version === this.base.version) {
      this.remote = null;
      return;
    }
    this.remote = doc;
    if (!this.editor || this.inflight || this.closed) return;
    this.remote = null;
    this.merge(doc);
    if (this.dirty) this.arm();
  }

  /** Brings `doc` into the editor, keeping local edits, and makes it the base of the next save. */
  private merge(doc: DrawingDoc): void {
    const editor = this.editor;
    if (!editor) return;
    if (!doc.parsed.readable) {
      this.base = doc;
      this.baseVersion = doc.version;
      this.onError(new DrawingUnreadableError(doc.parsed.problems));
      return;
    }
    const current = editor.scene();
    const unsaved = this.dirty || editKey(current.elements, current.appState) !== this.cleanKey;
    const editing = new Set([...editor.editing()].map((id) => this.ids.fileId(id)));
    const merged = mergeDrawingElements(
      this.base.parsed.scene.elements,
      this.ids.file(current.elements),
      doc.parsed.scene.elements,
      { editing },
    );
    const files = mergeDrawingFiles(current.files, doc.parsed.scene.files);
    this.base = doc;
    this.baseVersion = doc.version;
    editor.replace(this.ids.local(merged), files);
    const after = editor.scene();
    if (unsaved) this.dirty = true;
    else this.cleanKey = editKey(after.elements, after.appState);
  }
}
