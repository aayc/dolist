import { SettingsPatchSectionSchemas, UpdateSettingsRequestSchema } from "@ddl/contract";
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

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

/** One patch schema per top-level section (the wire contract's), so a bad section only drops itself. */
export const SETTINGS_SECTION_SCHEMAS = SettingsPatchSectionSchemas;

/** Body of `PUT /api/settings`: a deep partial of AppSettings; unknown keys are rejected. */
export const SettingsPatchSchema = UpdateSettingsRequestSchema;

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
    const schema = Object.hasOwn(SETTINGS_SECTION_SCHEMAS, key)
      ? SETTINGS_SECTION_SCHEMAS[key as keyof typeof SETTINGS_SECTION_SCHEMAS]
      : undefined;
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
