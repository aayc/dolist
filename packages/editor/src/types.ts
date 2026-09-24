/**
 * Public contract of the markdown editor. Framework-agnostic: the web app wraps it in a React
 * component, the future desktop/mobile shells reuse the web app as-is.
 */
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TaskAgentStatus } from "@ddl/core";
import type { LinkTarget } from "./links";

/** An agent badge rendered at the end of a task line (or of a line a thread is anchored to). */
export interface LineAnnotation {
  /** Task id, or anchor id for a line anchor (stable across edits). */
  id: string;
  /** 0-based line. The editor maps it through subsequent edits until annotations are reset. */
  line: number;
  status: TaskAgentStatus;
  /** Short pill text, e.g. "Researching…", "Needs approval", "Done · 3 options". */
  label: string;
  unread: number;
  threadId: string | null;
  /** The thread is attached to the line itself rather than to a task: the line is highlighted. */
  lineAnchor?: boolean;
}

/** What hovering a link shows. Built from data the host already has; never by fetching the link. */
export type LinkPreview =
  | {
      kind: "web";
      url: string;
      title: string;
      /** Empty for links without a host (`mailto:`, `tel:`). */
      hostname: string;
      snippet?: string;
    }
  | {
      kind: "note";
      title: string;
      /** The note's first non-empty lines. */
      lines: readonly string[];
      /** No note has this name yet (following the link creates it). */
      missing?: boolean;
    };

export interface LinkPreviewRequest {
  link: LinkTarget;
  /** The link's visible text: its label, alias, target or URL. */
  label: string;
  /** The thread named by the agent marker of the link's line, when it has one. */
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
  /** The agent glyph ✦ at the end of a line the agent wrote (only lines naming their thread). */
  onAgentLineClick?(threadId: string): void;
  /**
   * Content for the card shown while hovering a link. Without it (or when it returns null), web
   * links show their label, host and URL, and note links show nothing.
   */
  onLinkPreview?(request: LinkPreviewRequest): LinkPreview | null | Promise<LinkPreview | null>;
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
