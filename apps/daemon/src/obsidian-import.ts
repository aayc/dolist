import { parsePersistedJson } from "@ddl/contract";
import {
  type AppSettings,
  type DeepPartial,
  type EditorSettings,
  isHiddenPath,
  type Logger,
  normalizePath,
  type ThemePreference,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { z } from "zod";

const DAILY_NOTES_FILE = ".obsidian/daily-notes.json";
const APP_FILE = ".obsidian/app.json";
const APPEARANCE_FILE = ".obsidian/appearance.json";

/** Obsidian's daily-notes defaults, used for keys missing from its config file. */
const OBSIDIAN_DAILY_FORMAT = "YYYY-MM-DD";

const DailyNotesFileSchema = z.looseObject({
  folder: z.string().optional(),
  format: z.string().optional(),
  template: z.string().optional(),
});

const AppFileSchema = z.looseObject({
  vimMode: z.boolean().optional(),
  livePreview: z.boolean().optional(),
  readableLineLength: z.boolean().optional(),
  showLineNumber: z.boolean().optional(),
  spellcheck: z.boolean().optional(),
});

const AppearanceFileSchema = z.looseObject({ theme: z.string().optional() });

const OBSIDIAN_THEMES: Record<string, ThemePreference> = {
  obsidian: "dark",
  moonstone: "light",
  system: "system",
};

/**
 * First-run import from an existing Obsidian vault: daily-note folder/format/template, editor
 * preferences (vim mode, …) and the base theme. Missing or unreadable files are skipped.
 */
export async function readObsidianSettings(
  storage: StorageProvider,
  logger: Logger,
): Promise<DeepPartial<AppSettings>> {
  const patch: DeepPartial<AppSettings> = {};

  const daily = await readConfig(storage, DAILY_NOTES_FILE, DailyNotesFileSchema, logger);
  if (daily) {
    patch.dailyNotes = {
      folder: cleanPath(daily.folder, "folder", logger),
      format: daily.format?.trim() || OBSIDIAN_DAILY_FORMAT,
      template: cleanPath(daily.template, "template", logger),
    };
  }

  const app = await readConfig(storage, APP_FILE, AppFileSchema, logger);
  if (app) {
    const editor: Partial<EditorSettings> = {};
    if (app.vimMode !== undefined) editor.vimMode = app.vimMode;
    if (app.livePreview !== undefined) editor.livePreview = app.livePreview;
    if (app.readableLineLength !== undefined) editor.readableLineLength = app.readableLineLength;
    if (app.showLineNumber !== undefined) editor.showLineNumbers = app.showLineNumber;
    if (app.spellcheck !== undefined) editor.spellcheck = app.spellcheck;
    if (Object.keys(editor).length > 0) patch.editor = editor;
  }

  const appearance = await readConfig(storage, APPEARANCE_FILE, AppearanceFileSchema, logger);
  const theme = appearance?.theme ? OBSIDIAN_THEMES[appearance.theme] : undefined;
  if (theme) patch.theme = theme;

  if (Object.keys(patch).length > 0) {
    logger.info("Imported settings from the Obsidian vault config", {
      sections: Object.keys(patch),
    });
  }
  return patch;
}

async function readConfig<S extends z.ZodType>(
  storage: StorageProvider,
  path: string,
  schema: S,
  logger: Logger,
): Promise<z.output<S> | null> {
  try {
    const file = await storage.read(path);
    if (!file) return null;
    const json = parsePersistedJson(file.content);
    if (!json.ok) {
      logger.warn("Could not read Obsidian config", { path, error: json.reason });
      return null;
    }
    const parsed = schema.safeParse(json.value);
    if (parsed.success) return parsed.data;
    logger.warn("Ignoring unexpected Obsidian config", { path });
  } catch (error) {
    logger.warn("Could not read Obsidian config", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

/** Vault-relative, trailing-slash-free path; invalid or hidden values fall back to the vault root. */
function cleanPath(value: string | undefined, field: string, logger: Logger): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  const normalized = tryNormalize(trimmed);
  if (normalized !== null && !isHiddenPath(normalized)) return normalized;
  logger.warn("Ignoring unusable Obsidian daily-notes setting", { field });
  return "";
}

function tryNormalize(path: string): string | null {
  try {
    return normalizePath(path);
  } catch {
    return null;
  }
}
