import {
  createMarkdownEditor,
  DEFAULT_EDITOR_CONFIG,
  type EditorConfig,
  type LineAnnotation,
  type MarkdownEditor,
} from "@ddl/editor";
import { LruMap } from "../../lib/lru";

type EditorStateLike = ReturnType<MarkdownEditor["getState"]>;

interface CachedState {
  state: EditorStateLike;
  /** Config generation the state was created/last shown with. */
  generation: number;
}

export interface EditorControllerDeps {
  /** Initial content for a note without a cached state. */
  contentOf(path: string): string | null;
  /** A local edit happened in the active note (called synchronously per change; keep O(1)). */
  onLocalEdit(path: string): void;
  /** The active note's document was replaced programmatically (remote change). */
  onDocumentReplaced(path: string): void;
  onCursorLine(path: string, line: number): void;
  onAnnotationClick(annotation: LineAnnotation): void;
  onWikiLinkClick(target: string, newPane: boolean): void;
  onExternalLinkClick(url: string): void;
  onSaveRequested(path: string): void;
  /** Called synchronously before the active note is swapped out (flush unsaved edits). */
  beforeDeactivate(path: string): void;
  canEvict(path: string): boolean;
}

/**
 * Drives the ONE MarkdownEditor instance. Each open note keeps its own EditorState (undo history,
 * selection, scroll) so switching notes is a state swap, not a re-parse.
 */
export class EditorController {
  private readonly deps: EditorControllerDeps;
  private editor: MarkdownEditor | null = null;
  private readonly states: LruMap<string, CachedState>;
  private activePath: string | null = null;
  private applying = false;
  private config: EditorConfig;
  private generation = 0;
  /** Annotations last sent for the shown state; null = unknown (must be re-sent). */
  private annotations: readonly LineAnnotation[] | null = null;

  constructor(deps: EditorControllerDeps, config: Partial<EditorConfig> = {}) {
    this.deps = deps;
    this.config = { ...DEFAULT_EDITOR_CONFIG, ...config };
    this.states = new LruMap(24, (path) => deps.canEvict(path));
  }

  get active(): string | null {
    return this.activePath;
  }

  get mounted(): boolean {
    return this.editor !== null;
  }

  mount(parent: HTMLElement): void {
    if (this.editor) return;
    const pending = this.activePath;
    this.editor = createMarkdownEditor(parent, {
      doc: "",
      config: this.config,
      callbacks: {
        onDocChange: () => {
          if (this.applying || this.activePath === null) return;
          this.deps.onLocalEdit(this.activePath);
        },
        onCursorLine: (line) => {
          if (this.activePath !== null) this.deps.onCursorLine(this.activePath, line);
        },
        onAnnotationClick: (annotation) => this.deps.onAnnotationClick(annotation),
        onWikiLinkClick: (target, options) => this.deps.onWikiLinkClick(target, options.newPane),
        onExternalLinkClick: (url) => this.deps.onExternalLinkClick(url),
        onSave: () => {
          if (this.activePath !== null) this.deps.onSaveRequested(this.activePath);
        },
      },
    });
    this.activePath = null;
    if (pending !== null) this.show(pending);
  }

  unmount(): void {
    if (!this.editor) return;
    if (this.activePath !== null) this.deps.beforeDeactivate(this.activePath);
    this.editor.destroy();
    this.editor = null;
    // States belong to that editor's extension set; a new instance rebuilds them.
    this.states.clear();
  }

  /** Swaps the editor to `path` (synchronous). Content must already be loaded. */
  show(path: string | null): void {
    const editor = this.editor;
    if (!editor) {
      this.activePath = path;
      return;
    }
    if (path === this.activePath) return;
    const previous = this.activePath;
    if (previous !== null) {
      this.deps.beforeDeactivate(previous);
      this.states.set(previous, { state: editor.getState(), generation: this.generation });
    }
    this.activePath = path;
    // A cached state may carry badges from when it was last shown; the next sync re-sends them.
    this.annotations = null;
    if (path === null) return;
    const cached = this.states.get(path);
    this.states.delete(path);
    const state = cached?.state ?? editor.createState(this.deps.contentOf(path) ?? "");
    this.applying = true;
    try {
      editor.setState(state);
      if (cached && cached.generation !== this.generation) editor.configure(this.config);
    } finally {
      this.applying = false;
    }
  }

  /** Content that changed elsewhere (no local edits pending). */
  applyRemote(path: string, content: string): void {
    if (path !== this.activePath || !this.editor) {
      this.states.delete(path);
      return;
    }
    if (this.editor.getDocument() === content) return;
    this.applying = true;
    try {
      this.editor.setDocument(content);
    } finally {
      this.applying = false;
    }
    this.deps.onDocumentReplaced(path);
  }

  /** Live document of `path` if it is the active note. */
  readLive(path: string): string | null {
    return path === this.activePath && this.editor ? this.editor.getDocument() : null;
  }

  getDocument(): string | null {
    return this.editor && this.activePath !== null ? this.editor.getDocument() : null;
  }

  rename(from: string, to: string): void {
    for (const key of [...this.states.keys()]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      const cached = this.states.peek(key);
      this.states.delete(key);
      if (cached) this.states.set(`${to}${key.slice(from.length)}`, cached);
    }
    if (this.activePath === from) this.activePath = to;
    else if (this.activePath?.startsWith(`${from}/`))
      this.activePath = `${to}${this.activePath.slice(from.length)}`;
  }

  forget(path: string): void {
    this.states.delete(path);
  }

  configure(config: Partial<EditorConfig>): void {
    const next = { ...this.config, ...config };
    const changed = (Object.keys(next) as Array<keyof EditorConfig>).some(
      (k) => next[k] !== this.config[k],
    );
    if (!changed) return;
    this.config = next;
    this.generation++;
    this.editor?.configure(next);
  }

  setAnnotations(annotations: readonly LineAnnotation[]): void {
    if (annotations.length === 0 && this.annotations?.length === 0) return;
    this.annotations = annotations;
    this.editor?.setAnnotations(annotations);
  }

  focus(): void {
    this.editor?.focus();
  }

  scrollToLine(line: number): void {
    if (this.editor && this.activePath !== null) this.editor.scrollToLine(Math.max(0, line));
  }
}
