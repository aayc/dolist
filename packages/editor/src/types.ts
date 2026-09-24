/**
 * Public contract of the markdown editor. Framework-agnostic: the web app wraps it in a React
 * component, the future desktop/mobile shells reuse the web app as-is.
 */
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TaskAgentStatus } from "@ddl/core";

/** An agent badge rendered at the end of a task line. */
export interface LineAnnotation {
  /** Task id (stable across edits). */
  id: string;
  /** 0-based line. The editor maps it through subsequent edits until annotations are reset. */
  line: number;
  status: TaskAgentStatus;
  /** Short pill text, e.g. "Researching…", "Needs approval", "Done · 3 options". */
  label: string;
  unread: number;
  threadId: string | null;
}

export interface EditorConfig {
  vimMode: boolean;
  livePreview: boolean;
  readableLineLength: boolean;
  spellcheck: boolean;
  showLineNumbers: boolean;
  fontSize: number;
  readOnly: boolean;
}

export interface EditorCallbacks {
  /** Every document change. Keep it cheap; the host debounces persistence. */
  onDocChange?(doc: string, meta: { userEvent: boolean }): void;
  onAnnotationClick?(annotation: LineAnnotation): void;
  onWikiLinkClick?(target: string, options: { newPane: boolean }): void;
  onExternalLinkClick?(url: string): void;
  /** Cursor moved to a different line (throttle before sending presence). */
  onCursorLine?(line: number): void;
  /** Mod-s */
  onSave?(): void;
}

export interface MarkdownEditor {
  readonly view: EditorView;
  getDocument(): string;
  /** Replace the document for an external change, keeping selection/scroll where possible. */
  setDocument(doc: string, options?: { resetHistory?: boolean }): void;
  /** Build a fresh state (current extensions/config) — used to cache one state per open note. */
  createState(doc: string): EditorState;
  getState(): EditorState;
  /** Swap the whole state (instant note switching with per-note undo history). */
  setState(state: EditorState): void;
  setAnnotations(annotations: readonly LineAnnotation[]): void;
  configure(config: Partial<EditorConfig>): void;
  focus(): void;
  scrollToLine(line: number): void;
  destroy(): void;
}

export interface CreateEditorOptions {
  doc: string;
  config?: Partial<EditorConfig>;
  callbacks?: EditorCallbacks;
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  vimMode: false,
  livePreview: true,
  readableLineLength: true,
  spellcheck: false,
  showLineNumbers: false,
  fontSize: 16,
  readOnly: false,
};
