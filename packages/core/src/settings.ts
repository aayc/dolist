import { DEFAULT_DAILY_NOTE_SETTINGS, DEFAULT_WEEKLY_NOTE_SETTINGS } from "./daily-notes";
import type { AgentSettings, AppSettings } from "./wire";

/**
 * What runs the orchestrator and subagent conversations: `pi` (the Pi coding-agent SDK on an
 * OpenRouter model) or `cursor` (the Cursor CLI's agent, signed in with the user's Cursor account).
 */
export const AGENT_HARNESS_KINDS = ["pi", "cursor"] as const;
export type AgentHarnessKind = (typeof AGENT_HARNESS_KINDS)[number];

/**
 * When agents ask before acting, from strictest to loosest (each allows everything the ones before
 * it allow). The safety gate applies it to the evaluator's verdicts; hard denies apply under every
 * policy.
 * - `ask_every_action`: every effectful action asks, even ones the evaluator allows.
 * - `ask_risky`: the evaluator decides (the default).
 * - `ask_high_risk`: only verdicts of high or critical risk ask.
 * - `run_everything`: nothing asks.
 */
export const APPROVAL_POLICIES = [
  "ask_every_action",
  "ask_risky",
  "ask_high_risk",
  "run_everything",
] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "ask_risky";

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
