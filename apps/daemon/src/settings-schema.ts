import { UpdateSettingsRequestSchema } from "@ddl/contract";
import {
  type AppSettings,
  dailyNotePath,
  errorMessage,
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

/** Body of `PUT /api/settings`: a deep partial of AppSettings; unknown keys are rejected. */
export const SettingsPatchSchema = UpdateSettingsRequestSchema;

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
    problems.push(`${section}: ${errorMessage(error)}`);
  }
}

function checkTemplate(problems: string[], section: string, settings: { template: string }): void {
  try {
    const path = templateNotePath(settings);
    if (path && isSidecarPath(path))
      problems.push(`${section}: template cannot live in the sidecar`);
  } catch (error) {
    problems.push(`${section}: ${errorMessage(error)}`);
  }
}
