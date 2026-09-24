/**
 * AppSettings. The full shape is a response (tolerant); `UpdateSettingsRequest` is its strict deep
 * partial. Both share the same field constraints, which are the daemon's accepted ranges.
 */
import { z } from "zod";
import { ModelIdSchema, WIRE_LIMITS } from "./primitives";
import { named } from "./registry";

export const SETTINGS_RANGES = {
  fontSize: { min: 8, max: 48 },
  settleMs: { min: 0, max: 120_000 },
  maxConcurrentSubagents: { min: 1, max: 32 },
  watchDays: { min: 0, max: 366 },
  approvalTimeoutMs: { min: 60_000, max: 30 * 24 * 60 * 60 * 1000 },
  folderLength: 512,
  formatLength: 128,
  templateLength: 512,
} as const;

const range = (r: { min: number; max: number }) => z.int().min(r.min).max(r.max);

export const ThemePreferenceSchema = named(
  "ThemePreference",
  "UI theme.",
  z.enum(["system", "light", "dark"]),
);

const editorFields = {
  vimMode: z.boolean(),
  livePreview: z.boolean().describe("Obsidian-style live preview."),
  readableLineLength: z.boolean(),
  fontSize: z.number().min(SETTINGS_RANGES.fontSize.min).max(SETTINGS_RANGES.fontSize.max),
  spellcheck: z.boolean(),
  showLineNumbers: z.boolean(),
};

const periodicNoteFields = {
  folder: z
    .string()
    .max(SETTINGS_RANGES.folderLength)
    .describe("Vault folder for the notes; empty = vault root."),
  format: z
    .string()
    .max(SETTINGS_RANGES.formatLength)
    .describe("Moment-style file name format; may contain `/` for nested folders."),
  template: z
    .string()
    .max(SETTINGS_RANGES.templateLength)
    .describe("Template note path; empty = no template."),
};

const watchFields = {
  pastDays: range(SETTINGS_RANGES.watchDays),
  futureDays: range(SETTINGS_RANGES.watchDays),
};

/** A model id in a settings patch: surrounding whitespace is trimmed, then it must be non-empty. */
const ModelIdInputSchema = z.string().trim().min(1).max(WIRE_LIMITS.modelIdLength);

const agentScalarFields = {
  enabled: z.boolean().describe("Master switch: when false the orchestrator ignores note changes."),
  settleMs: range(SETTINGS_RANGES.settleMs).describe(
    "Quiet period after the last edit to a task before the orchestrator looks at it.",
  ),
  maxConcurrentSubagents: range(SETTINGS_RANGES.maxConcurrentSubagents),
  actOnExistingTasks: z.boolean(),
  approvalTimeoutMs: range(SETTINGS_RANGES.approvalTimeoutMs).describe(
    "How long an approval request waits before it is auto-denied.",
  ),
};

export const EditorSettingsSchema = named(
  "EditorSettings",
  "Editor preferences.",
  z.looseObject(editorFields),
);

export const DailyNoteSettingsSchema = named(
  "DailyNoteSettings",
  "Where daily notes live (mirrors Obsidian's daily-notes config).",
  z.looseObject(periodicNoteFields),
);

export const WeeklyNoteSettingsSchema = named(
  "WeeklyNoteSettings",
  "Where weekly notes live.",
  z.looseObject(periodicNoteFields),
);

export const AgentWatchWindowSchema = named(
  "AgentWatchWindow",
  "Days around today whose daily notes the orchestrator watches.",
  z.looseObject(watchFields),
);

export const AgentSettingsSchema = named(
  "AgentSettings",
  "Orchestrator and subagent settings.",
  z.looseObject({
    ...agentScalarFields,
    model: ModelIdSchema.describe("OpenRouter model id for the orchestrator and subagents."),
    judgeModel: ModelIdSchema.describe("OpenRouter model id for the safety judge."),
    watch: AgentWatchWindowSchema,
  }),
);

export const AppSettingsSchema = named(
  "AppSettings",
  "All user settings (stored in the vault sidecar so they travel with the vault).",
  z.looseObject({
    theme: ThemePreferenceSchema,
    editor: EditorSettingsSchema,
    dailyNotes: DailyNoteSettingsSchema,
    weeklyNotes: WeeklyNoteSettingsSchema,
    agent: AgentSettingsSchema,
  }),
);

/**
 * Patch schema of each top-level settings section. The daemon also uses them to keep the valid
 * sections of a hand-edited settings file.
 */
export const SettingsPatchSectionSchemas = {
  theme: ThemePreferenceSchema,
  editor: z.strictObject(editorFields).partial(),
  dailyNotes: z.strictObject(periodicNoteFields).partial(),
  weeklyNotes: z.strictObject(periodicNoteFields).partial(),
  agent: z
    .strictObject({
      ...agentScalarFields,
      model: ModelIdInputSchema,
      judgeModel: ModelIdInputSchema,
      watch: z.strictObject(watchFields).partial(),
    })
    .partial(),
};

export const UpdateSettingsRequestSchema = named(
  "UpdateSettingsRequest",
  "A deep partial of AppSettings (PATCH semantics). Unknown keys are rejected.",
  z.strictObject(SettingsPatchSectionSchemas).partial(),
);
