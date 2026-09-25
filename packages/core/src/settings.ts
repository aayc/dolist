import {
  type DailyNoteSettings,
  DEFAULT_DAILY_NOTE_SETTINGS,
  DEFAULT_WEEKLY_NOTE_SETTINGS,
  type WeeklyNoteSettings,
} from "./daily-notes";

export type ThemePreference = "system" | "light" | "dark";

export interface EditorSettings {
  vimMode: boolean;
  /**
   * Vim startup commands, one ex command per line (`imap jj <Esc>`, `set clipboard=unnamed`);
   * lines starting with `"` are comments. Applied when vim loads and whenever this changes.
   */
  vimrc: string;
  /** Obsidian-style live preview (hide markdown syntax away from the cursor). */
  livePreview: boolean;
  readableLineLength: boolean;
  fontSize: number;
  spellcheck: boolean;
  showLineNumbers: boolean;
}

/** Days around today whose daily notes the orchestrator watches. */
export interface AgentWatchWindow {
  pastDays: number;
  futureDays: number;
}

/**
 * What runs the orchestrator and subagent conversations: `pi` (the Pi coding-agent SDK on an
 * OpenRouter model) or `cursor` (the Cursor CLI's agent, signed in with the user's Cursor account).
 */
export type AgentHarnessKind = "pi" | "cursor";

export const AGENT_HARNESS_KINDS: readonly AgentHarnessKind[] = ["pi", "cursor"];

/**
 * When agents ask before acting. The safety gate applies it to the evaluator's verdicts; hard
 * denies apply under every policy.
 * - `ask_every_action`: every effectful action asks, even ones the evaluator allows.
 * - `ask_risky`: the evaluator decides (the default).
 * - `ask_high_risk`: only verdicts of high or critical risk ask.
 * - `run_everything`: nothing asks.
 */
export type ApprovalPolicy = "ask_every_action" | "ask_risky" | "ask_high_risk" | "run_everything";

/** From strictest to loosest: each policy allows everything the ones before it allow. */
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
  "ask_every_action",
  "ask_risky",
  "ask_high_risk",
  "run_everything",
];

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "ask_risky";

/** Value ranges are enforced by the settings schemas in `@ddl/contract`. */
export interface AgentSettings {
  /** Master switch. When false the orchestrator ignores note changes entirely. */
  enabled: boolean;
  /** Quiet period after the last edit to a task before the orchestrator looks at it. */
  settleMs: number;
  maxConcurrentSubagents: number;
  harness: AgentHarnessKind;
  /** OpenRouter model id for the orchestrator and subagents with the Pi harness. */
  model: string;
  /**
   * Cursor model for the orchestrator and subagents with the Cursor harness (`claude-opus-5-5`,
   * `composer-2.5`). The CLI's agent mode runs one preset per model, so a variant id from
   * `agent models` (`claude-opus-5-5-high-fast`) runs as its model's preset.
   */
  cursorModel: string;
  /** OpenRouter model id for the safety judge (defaults to `model`). */
  judgeModel: string;
  /** Which daily notes are watched, relative to today. */
  watch: AgentWatchWindow;
  /** Treat tasks that already exist when a note is first seen as new work. */
  actOnExistingTasks: boolean;
  /** How long an approval request waits before it is auto-denied. */
  approvalTimeoutMs: number;
  /** When agents ask before acting (see `ApprovalPolicy`). */
  approvalPolicy: ApprovalPolicy;
}

/**
 * The always-on machine every device of the vault can hand the agent to. Its name and address sync
 * with the settings; each device pairs with it once and keeps its own credential in `DDL_HOME`.
 */
export interface AlwaysOnMachine {
  /** 1–64 characters, trimmed. */
  name: string;
  /** `https://<host>[:port]` in the form `normalizeMachineUrl` returns. */
  url: string;
}

/** Remote access settings shared by every device (non-secret). */
export interface RemoteSettings {
  alwaysOnMachine: AlwaysOnMachine | null;
}

export interface AppSettings {
  theme: ThemePreference;
  editor: EditorSettings;
  dailyNotes: DailyNoteSettings;
  weeklyNotes: WeeklyNoteSettings;
  agent: AgentSettings;
  remote: RemoteSettings;
}

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
export const DEFAULT_CURSOR_MODEL = "claude-opus-5-5";

/** The model id the configured harness runs its conversations on. */
export function agentModel(agent: AgentSettings): string {
  return agent.harness === "cursor" ? agent.cursorModel : agent.model;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  editor: {
    vimMode: false,
    vimrc: "",
    livePreview: true,
    readableLineLength: true,
    fontSize: 16,
    spellcheck: false,
    showLineNumbers: false,
  },
  dailyNotes: DEFAULT_DAILY_NOTE_SETTINGS,
  weeklyNotes: DEFAULT_WEEKLY_NOTE_SETTINGS,
  agent: {
    enabled: true,
    settleMs: 2500,
    maxConcurrentSubagents: 3,
    harness: "pi",
    model: DEFAULT_MODEL,
    cursorModel: DEFAULT_CURSOR_MODEL,
    judgeModel: DEFAULT_MODEL,
    watch: { pastDays: 0, futureDays: 7 },
    actOnExistingTasks: true,
    approvalTimeoutMs: 12 * 60 * 60 * 1000,
    approvalPolicy: DEFAULT_APPROVAL_POLICY,
  },
  remote: { alwaysOnMachine: null },
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merges a partial patch into settings. Unknown keys are dropped; arrays are replaced. */
export function mergeSettings<T extends object>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out) || value === undefined) continue;
    const current = out[key];
    out[key] =
      isPlainObject(current) && isPlainObject(value)
        ? mergeSettings(current, value as DeepPartial<typeof current>)
        : value;
  }
  return out as T;
}
