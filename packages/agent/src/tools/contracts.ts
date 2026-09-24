/**
 * Canonical tool names and input shapes shared by the tool implementations (orchestrator,
 * execution), the safety rules that inspect them, the evals and the UI's tool-call rendering.
 * Change a name here and every consumer follows.
 */

export const TOOL = {
  // Orchestrator-only
  spawnSubagent: "spawn_subagent",
  postComment: "post_comment",
  askUser: "ask_user",
  setTaskStatus: "set_task_status",
  messageSubagent: "message_subagent",
  cancelSubagent: "cancel_subagent",
  listTasks: "list_tasks",
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
  // Harness built-ins (Pi coding tools, bound to the task workspace)
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  grep: "grep",
  find: "find",
  ls: "ls",
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

export interface ComputerClickInput {
  x: number;
  y: number;
  button?: "left" | "right";
  double?: boolean;
  element: string;
}
export interface ComputerMoveInput {
  x: number;
  y: number;
}
export interface ComputerTypeInput {
  text: string;
}
export interface ComputerKeyInput {
  combo: string;
}
export interface ComputerScrollInput {
  dx: number;
  dy: number;
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
