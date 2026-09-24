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
  /** Vim startup commands (see `AppSettings.editor.vimrc`); global to every vim editor. */
  vimrc: string;
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
  /**
   * `target` is the note part of the link (no `#subpath`, no alias), e.g. `Daily/2026-06-19` for
   * `[[Daily/2026-06-19#Tasks|today]]`; `subpath` is `Tasks` (`^block` for block refs). Relative
   * markdown links (`[x](Note.md)`) arrive here too.
   */
  onWikiLinkClick?(target: string, options: { newPane: boolean; subpath?: string }): void;
  /** Only http(s), mailto and tel URLs are ever passed (`www.` gets `https://`). */
  onExternalLinkClick?(url: string): void;
  /** Cursor moved to a different line (throttle before sending presence). */
  onCursorLine?(line: number): void;
  /** Mod-s, vim `:w` (and `:wq`/`:x` before `onClose`). */
  onSave?(): void;
  /** vim `:wa`: save every open note. */
  onSaveAll?(): void;
  /** vim `:q`/`:q!`/`:wq`/`:x`: close this note's tab; `all` for `:qa`/`:wqa`. */
  onClose?(options: { all: boolean }): void;
  /** vim `:e <note>`/`:tabedit <note>`: open a note by name or path; `null` = let the user pick. */
  onOpenNote?(target: string | null, options: { newTab: boolean }): void;
  /** vim `gt`/`gT`, `:tabnext`/`:bnext`…: switch `delta` tabs, or to the 0-based tab `index`. */
  onSwitchTab?(to: { delta: number } | { index: number }): void;
  /** vim `:obcommand <id>`: run an app command; false when there is no such command. */
  onRunCommand?(id: string): boolean;
  /** Vim mode or pending keys changed (`null`: vim is off). Called only on changes. */
  onVimStatus?(status: VimStatus | null): void;
  /** The vimrc was (re)applied; lines vim rejected, with its message. */
  onVimrcApplied?(problems: readonly VimrcProblem[]): void;
}

export type VimModeName =
  | "normal"
  | "insert"
  | "replace"
  | "visual"
  | "visual-line"
  | "visual-block";

export interface VimStatus {
  mode: VimModeName;
  /** Keys of a command still being typed (Vim's "showcmd"), e.g. `2d` or `"a`. */
  pending: string;
  /** Recording a macro into this register. */
  recording: string | null;
}

export interface VimrcProblem {
  /** 0-based line in the vimrc. */
  line: number;
  message: string;
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
  vimrc: "",
  livePreview: true,
  readableLineLength: true,
  spellcheck: false,
  showLineNumbers: false,
  fontSize: 16,
  readOnly: false,
};
