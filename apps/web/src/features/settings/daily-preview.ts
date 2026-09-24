import { type DailyNoteSettings, dailyNotePath, templateNotePath, today } from "@ddl/core";

export interface DailyPreview {
  path: string | null;
  templateMissing: boolean;
  error: string | null;
}

/** Live preview of today's daily-note path for the settings form. */
export function dailyPreview(
  settings: DailyNoteSettings,
  files: readonly string[],
  now: Date = new Date(),
): DailyPreview {
  try {
    const path = dailyNotePath(today(now), settings);
    let templateMissing = false;
    const template = templateNotePath(settings);
    if (template) templateMissing = !files.includes(template);
    return { path, templateMissing, error: null };
  } catch (error) {
    return {
      path: null,
      templateMissing: false,
      error: error instanceof Error ? error.message : "Invalid folder or format",
    };
  }
}
