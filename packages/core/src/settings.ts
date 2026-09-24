import {
  type DailyNoteSettings,
  DEFAULT_DAILY_NOTE_SETTINGS,
  DEFAULT_WEEKLY_NOTE_SETTINGS,
  type WeeklyNoteSettings,
} from "./daily-notes";

export type ThemePreference = "system" | "light" | "dark";

export interface EditorSettings {
  vimMode: boolean;
  /** Obsidian-style live preview (hide markdown syntax away from the cursor). */
  livePreview: boolean;
  readableLineLength: boolean;
  fontSize: number;
  spellcheck: boolean;
  showLineNumbers: boolean;
}

export interface AgentSettings {
  /** Master switch. When false the orchestrator ignores note changes entirely. */
  enabled: boolean;
  /** Quiet period after the last edit to a task before the orchestrator looks at it. */
  settleMs: number;
  maxConcurrentSubagents: number;
  /** OpenRouter model id for the orchestrator and subagents. */
  model: string;
  /** OpenRouter model id for the safety judge (defaults to `model`). */
  judgeModel: string;
  /** Which daily notes are watched, relative to today. */
  watch: { pastDays: number; futureDays: number };
  /** Treat tasks that already exist when a note is first seen as new work. */
  actOnExistingTasks: boolean;
  /** How long an approval request waits before it is auto-denied. */
  approvalTimeoutMs: number;
}

export interface AppSettings {
  theme: ThemePreference;
  editor: EditorSettings;
  dailyNotes: DailyNoteSettings;
  weeklyNotes: WeeklyNoteSettings;
  agent: AgentSettings;
}

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  editor: {
    vimMode: false,
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
    model: DEFAULT_MODEL,
    judgeModel: DEFAULT_MODEL,
    watch: { pastDays: 0, futureDays: 7 },
    actOnExistingTasks: true,
    approvalTimeoutMs: 12 * 60 * 60 * 1000,
  },
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
