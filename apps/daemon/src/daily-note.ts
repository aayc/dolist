import {
  type AppSettings,
  DEFAULT_DAILY_NOTE_CONTENT,
  dailyNotePath,
  errorMessage,
  isHiddenPath,
  isSidecarPath,
  type LocalDate,
  renderTemplate,
  stem,
  templateNotePath,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { ApiError } from "./errors";

export function resolveDailyPath(date: LocalDate, settings: AppSettings): string {
  let path: string;
  try {
    path = dailyNotePath(date, settings.dailyNotes);
  } catch (error) {
    throw new ApiError(
      400,
      "invalid_settings",
      `Invalid daily note settings: ${errorMessage(error)}`,
    );
  }
  if (isHiddenPath(path)) {
    throw new ApiError(400, "invalid_settings", "Daily notes are configured in a hidden folder");
  }
  return path;
}

export async function renderDailyNote(
  storage: StorageProvider,
  settings: AppSettings,
  path: string,
  date: LocalDate,
  now: Date,
): Promise<string> {
  const template = await readTemplate(storage, settings);
  if (template === null) return DEFAULT_DAILY_NOTE_CONTENT;
  return renderTemplate(template, { title: stem(path), date, now });
}

async function readTemplate(
  storage: StorageProvider,
  settings: AppSettings,
): Promise<string | null> {
  let path: string | null;
  try {
    path = templateNotePath(settings.dailyNotes);
  } catch {
    return null;
  }
  if (!path || isSidecarPath(path)) return null;
  const file = await storage.read(path);
  return file ? file.content : null;
}
