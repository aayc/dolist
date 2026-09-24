import {
  type AppSettings,
  type DeepPartial,
  dailyNotePath,
  isHiddenPath,
  isSidecarPath,
  templateNotePath,
  today,
  weeklyNotePath,
} from "@ddl/core";
import { z } from "zod";

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

const Bool = z.boolean();
const ModelId = z.string().trim().min(1).max(200);

const PeriodicNotesPatch = z
  .strictObject({
    folder: z.string().max(512),
    format: z.string().max(128),
    template: z.string().max(512),
  })
  .partial();

/** One schema per top-level section so a bad section in a hand-edited file only drops itself. */
export const SETTINGS_SECTION_SCHEMAS = {
  theme: z.enum(["system", "light", "dark"]),
  editor: z
    .strictObject({
      vimMode: Bool,
      livePreview: Bool,
      readableLineLength: Bool,
      fontSize: z.number().min(8).max(48),
      spellcheck: Bool,
      showLineNumbers: Bool,
    })
    .partial(),
  dailyNotes: PeriodicNotesPatch,
  weeklyNotes: PeriodicNotesPatch,
  agent: z
    .strictObject({
      enabled: Bool,
      settleMs: z.int().min(0).max(120_000),
      maxConcurrentSubagents: z.int().min(1).max(32),
      model: ModelId,
      judgeModel: ModelId,
      watch: z
        .strictObject({ pastDays: z.int().min(0).max(366), futureDays: z.int().min(0).max(366) })
        .partial(),
      actOnExistingTasks: Bool,
      approvalTimeoutMs: z
        .int()
        .min(60_000)
        .max(30 * 24 * 60 * 60 * 1000),
    })
    .partial(),
};

/** Body of `PUT /api/settings`: a deep partial of AppSettings; unknown keys are rejected. */
export const SettingsPatchSchema = z
  .strictObject(SETTINGS_SECTION_SCHEMAS)
  .partial() satisfies z.ZodType<DeepPartial<AppSettings>>;

/** Keeps the valid sections of untrusted stored settings and reports the dropped ones. */
export function sanitizeStoredSettings(raw: unknown): {
  settings: DeepPartial<AppSettings>;
  dropped: string[];
} {
  const settings: Record<string, unknown> = {};
  const dropped: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings, dropped: ["(root)"] };
  }
  for (const [key, value] of Object.entries(raw)) {
    const schema = SETTINGS_SECTION_SCHEMAS[key as keyof typeof SETTINGS_SECTION_SCHEMAS];
    const parsed = schema?.safeParse(value);
    if (parsed?.success) settings[key] = parsed.data;
    else dropped.push(key);
  }
  return { settings: settings as DeepPartial<AppSettings>, dropped };
}

/** Cross-field checks a schema cannot express: note paths must stay visible and inside the vault. */
export function settingsProblems(settings: AppSettings, now: Date = new Date()): string[] {
  const date = today(now);
  const problems: string[] = [];
  checkNotePath(problems, "dailyNotes", () => dailyNotePath(date, settings.dailyNotes));
  checkNotePath(problems, "weeklyNotes", () => weeklyNotePath(date, settings.weeklyNotes));
  checkTemplate(problems, "dailyNotes", settings.dailyNotes);
  checkTemplate(problems, "weeklyNotes", settings.weeklyNotes);
  return problems;
}

function checkNotePath(problems: string[], section: string, resolve: () => string): void {
  try {
    const path = resolve();
    if (isHiddenPath(path)) problems.push(`${section}: notes would be created in a hidden folder`);
  } catch (error) {
    problems.push(`${section}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkTemplate(problems: string[], section: string, settings: { template: string }): void {
  try {
    const path = templateNotePath(settings);
    if (path && isSidecarPath(path))
      problems.push(`${section}: template cannot live in the sidecar`);
  } catch (error) {
    problems.push(`${section}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
