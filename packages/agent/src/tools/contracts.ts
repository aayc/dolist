/**
 * Canonical tool names and input shapes shared by the tool implementations (orchestrator,
 * execution), the safety rules that inspect them, the evals and the UI's tool-call rendering.
 * Change a name here and every consumer follows.
 */
import type { Capability } from "../execution/types";

export const TOOL = {
  // Orchestrator-only
  spawnSubagent: "spawn_subagent",
  postComment: "post_comment",
  askUser: "ask_user",
  setTaskStatus: "set_task_status",
  messageSubagent: "message_subagent",
  cancelSubagent: "cancel_subagent",
  listTasks: "list_tasks",
  anchorLine: "anchor_line",
  // Orchestrator-only: routines (standing jobs in the vault's Routines/ folder)
  createRoutine: "create_routine",
  updateRoutine: "update_routine",
  runRoutine: "run_routine",
  listRoutines: "list_routines",
  // Orchestrator and subagents: the agent's own text in the user's notes
  editNote: "edit_note",
  // Subagent ↔ thread
  postUpdate: "post_update",
  createArtifact: "create_artifact",
  finishTask: "finish_task",
  // Knowledge (read-only)
  readNote: "read_note",
  searchNotes: "search_notes",
  webFetch: "web_fetch",
  webSearch: "web_search",
  // Browser (execution provider)
  browserNavigate: "browser_navigate",
  browserSnapshot: "browser_snapshot",
  browserClick: "browser_click",
  browserType: "browser_type",
  browserSelectOption: "browser_select_option",
  browserPressKey: "browser_press_key",
  browserScroll: "browser_scroll",
  browserBack: "browser_back",
  browserScreenshot: "browser_screenshot",
  browserExtractText: "browser_extract_text",
  // Computer use (execution provider, macOS)
  computerScreenshot: "computer_screenshot",
  computerClick: "computer_click",
  computerMove: "computer_move",
  computerType: "computer_type",
  computerKey: "computer_key",
  computerScroll: "computer_scroll",
  // App control (computer use through the helper: one app at a time, in the background)
  computerApps: "computer_apps",
  computerOpenApp: "computer_open_app",
  computerAppState: "computer_app_state",
  computerPress: "computer_press",
  computerSetValue: "computer_set_value",
  // Harness built-ins (Pi coding tools, bound to the task workspace)
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  find: "find",
  ls: "ls",
  // Mock mode only: a fake irreversible action that always needs approval (exercises the flow).
  mockIrreversibleAction: "mock_irreversible_action",
} as const;

export type ToolName = (typeof TOOL)[keyof typeof TOOL];

/** Prefix of tools contributed by MCP connectors: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = "mcp__";

// ── Input shapes (what the model sends) ─────────────────────────────────────

/**
 * Every browser/computer action that interacts with an element carries `element`: a short human
 * description of what is being interacted with ("Place order button"). The safety evaluator and
 * approval cards rely on it (same idea as Playwright MCP's `element` parameter).
 */
export interface BrowserTargetInput {
  ref?: string;
  selector?: string;
  text?: string;
  element: string;
}

export interface BrowserNavigateInput {
  url: string;
}
export interface BrowserClickInput extends BrowserTargetInput {}
export interface BrowserTypeInput extends BrowserTargetInput {
  text: string;
  submit?: boolean;
  clear?: boolean;
}
export interface BrowserSelectOptionInput extends BrowserTargetInput {
  values: string[];
}
export interface BrowserPressKeyInput {
  key: string;
}
export interface BrowserScrollInput {
  direction: "up" | "down";
  pixels?: number;
}
export interface BrowserScreenshotInput {
  fullPage?: boolean;
}
export interface BrowserExtractTextInput {
  maxChars?: number;
}

/**
 * App control targets: `app` is the app's name (or bundle id) as the model knows it, `id` an
 * element id from that app's latest `computer_app_state`. Tools resolve both to the real app and
 * element, which approval cards and the safety rules see alongside the model's words.
 */
export interface AppTargetInput {
  app?: string;
  id?: string;
}

export interface ComputerScreenshotInput {
  app?: string;
}
/** Screen-level: `x`/`y` required. With `app`: `id`, or `x`/`y` in that app's last screenshot. */
export interface ComputerClickInput extends AppTargetInput {
  x?: number;
  y?: number;
  button?: "left" | "right";
  double?: boolean;
  element: string;
}
export interface ComputerMoveInput {
  x: number;
  y: number;
}
export interface ComputerTypeInput extends AppTargetInput {
  text: string;
}
export interface ComputerKeyInput {
  combo: string;
  app?: string;
}
export interface ComputerScrollInput extends AppTargetInput {
  dx: number;
  dy: number;
  x?: number;
  y?: number;
}
export interface ComputerAppsInput {
  installed?: boolean;
}
export interface ComputerOpenAppInput {
  app: string;
}
export interface ComputerAppStateInput {
  app: string;
  /** An element whose omitted descendants to read. */
  expand?: string;
  maxNodes?: number;
}
export interface ComputerPressInput {
  app: string;
  id: string;
  action?:
    | "press"
    | "show-menu"
    | "confirm"
    | "cancel"
    | "increment"
    | "decrement"
    | "raise"
    | "pick"
    | "scroll-to-visible";
  /** What the model thinks it presses (the real label comes from the snapshot). */
  element?: string;
}
export interface ComputerSetValueInput {
  app: string;
  id: string;
  value: string;
  element?: string;
}

export interface WebFetchInput {
  url: string;
  maxChars?: number;
}
export interface WebSearchInput {
  query: string;
  maxResults?: number;
}

export interface ReadNoteInput {
  path: string;
}
export interface SearchNotesInput {
  query: string;
  limit?: number;
}

export interface PostUpdateInput {
  /** Markdown shown in the task's thread (and as the inline summary when `summary` is set). */
  text: string;
  /** Optional one-line status for the badge next to the task, e.g. "Comparing 3 flights". */
  summary?: string;
}
export interface AskUserInput {
  question: string;
}
export interface CreateArtifactInput {
  title: string;
  kind: "markdown" | "code" | "html" | "json" | "text";
  content: string;
  language?: string;
}
export interface FinishTaskInput {
  status: "done" | "failed" | "needs_user";
  /** Markdown summary of what was accomplished (posted to the thread). */
  summary: string;
  /** One-line badge text, e.g. "Booked · Tue 9:30am". */
  shortSummary?: string;
  /** Routine runs only: something is new or different since the previous run. */
  changed?: boolean;
}

// ── Orchestrator tools ──────────────────────────────────────────────────────

export interface SpawnSubagentInput {
  taskId: string;
  /** One-sentence goal with the concrete outcome. */
  goal: string;
  instructions?: string;
  capabilities: Capability[];
}
export interface PostCommentInput {
  taskId: string;
  /** Markdown shown in the task's thread. */
  text: string;
  /** Badge text next to the task; defaults to a shortened `text`. */
  summary?: string;
}
export interface OrchestratorAskUserInput {
  taskId: string;
  question: string;
}
/** Statuses the orchestrator may set directly (work states are driven by subagents). */
export type SettableTaskStatus = "ignored" | "done" | "waiting_user" | "failed";
export interface SetTaskStatusInput {
  taskId: string;
  status: SettableTaskStatus;
  summary?: string;
}
export interface MessageSubagentInput {
  taskId: string;
  text: string;
}
export interface CancelSubagentInput {
  taskId: string;
  reason: string;
}
export interface ListTasksInput {
  /** Defaults to today's daily note. */
  notePath?: string;
}
export interface AnchorLineInput {
  /** Defaults to today's daily note. */
  notePath?: string;
  /** 1-based, as numbered in the digest's note view. */
  line: number;
  /** The line's current text, to confirm it is the one meant. */
  text: string;
}

// ── Routines (orchestrator) ─────────────────────────────────────────────────

export interface CreateRoutineInput {
  /** The routine's file name (without `.md`), e.g. "Morning briefing". */
  name: string;
  /** A schedule phrase, e.g. "every weekday at 7:30". */
  schedule: string;
  /** What each run does, self-contained. */
  instructions: string;
  notify?: "always" | "when_changed" | "never";
  uses?: Capability[];
}
export interface UpdateRoutineInput {
  name: string;
  schedule?: string;
  instructions?: string;
  notify?: "always" | "when_changed" | "never";
  uses?: Capability[];
  paused?: boolean;
}
export interface RunRoutineInput {
  name: string;
}

// ── Editing notes (orchestrator and subagents) ──────────────────────────────

export const NOTE_EDIT_OPS = [
  "add_under",
  "insert_after",
  "append",
  "replace",
  "delete",
  "set_checkbox",
] as const;
export type NoteEditOp = (typeof NOTE_EDIT_OPS)[number];

/**
 * One change to a note. New and replacement lines are written as the agent's (they get an agent
 * marker); `replace`, `delete` and `set_checkbox` change an existing line, which counts as the
 * agent's own only with `mine: true` (checked against the note when the edit runs).
 */
export interface NoteEdit {
  op: NoteEditOp;
  /** `add_under`, `set_checkbox`: the task or anchor id. */
  taskId?: string;
  /** `insert_after`, `replace`, `delete`: 1-based line (0 = top of the note for `insert_after`). */
  line?: number;
  /** `insert_after`, `replace`, `delete`: the line's current text. */
  expect?: string;
  /** `add_under`, `insert_after`, `append`: the new lines. */
  lines?: string[];
  /** `replace`: the new text of the line (its indentation is kept). */
  text?: string;
  /** `set_checkbox`. */
  checked?: boolean;
  /** `replace`, `delete`, `set_checkbox`: the line is one the agent wrote. */
  mine?: boolean;
}
export interface EditNoteInput {
  /** Defaults to the note of `taskId` (a subagent's own task), else today's daily note. */
  notePath?: string;
  /** The task or anchor this edit belongs to: its thread signs the new lines. */
  taskId?: string;
  edits: NoteEdit[];
}

export interface MockIrreversibleActionInput {
  action: string;
  details: string;
}

/** Pi built-in shapes (see @earendil-works/pi-coding-agent tools). */
export interface BashInput {
  command: string;
  timeout?: number;
}
export interface WriteInput {
  path: string;
  content: string;
}
