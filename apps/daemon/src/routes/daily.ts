import { API_CONTRACT } from "@ddl/contract";
import {
  API_PATHS,
  type AppSettings,
  type DailyNoteResponse,
  DEFAULT_DAILY_NOTE_CONTENT,
  dailyNotePath,
  isHiddenPath,
  isSidecarPath,
  type LocalDate,
  parseISODate,
  renderTemplate,
  stem,
  templateNotePath,
  today,
  toISODate,
} from "@ddl/core";
import type { FileContent, StorageProvider } from "@ddl/storage";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { ApiError, errorMessage, isNamedError } from "../errors";
import { clientWriteSource, isTruthyFlag } from "../http-utils";

export function registerDailyRoutes(app: Hono, ctx: AppContext): void {
  /** `GET /api/daily/<YYYY-MM-DD|today>?create=1`, dates in the daemon's local time zone. */
  app.get(API_PATHS.daily, async (c) => {
    const param = API_CONTRACT.daily.params.safeParse({ date: c.req.param("date") });
    const value = param.success ? param.data.date : null;
    const date = value === "today" ? today(ctx.now()) : value && parseISODate(value);
    if (!date) throw new ApiError(400, "invalid_request", 'Date must be "today" or YYYY-MM-DD');
    const iso = toISODate(date);
    const settings = ctx.settings.get();
    const path = resolveDailyPath(date, settings);

    const existing = await ctx.storage.read(path);
    if (existing) return c.json(toDailyResponse(existing, iso, false));
    if (!isTruthyFlag(c.req.query("create"))) {
      throw new ApiError(404, "not_found", `No daily note for ${iso}`);
    }

    const content = await renderDailyNote(ctx.storage, settings, path, date, ctx.now());
    try {
      const result = await ctx.storage.write(path, content, { ifMatch: null });
      ctx.writes.record(result.path, result.version, clientWriteSource(c));
      const body: DailyNoteResponse = {
        path: result.path,
        content,
        version: result.version,
        mtime: result.mtime,
        date: iso,
        created: true,
      };
      return c.json(body);
    } catch (error) {
      // Another client (or Obsidian) created it first: return theirs.
      if (!isNamedError(error, "ConflictError")) throw error;
      const current = await ctx.storage.read(path);
      if (!current) throw error;
      return c.json(toDailyResponse(current, iso, false));
    }
  });
}

function resolveDailyPath(date: LocalDate, settings: AppSettings): string {
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

async function renderDailyNote(
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

function toDailyResponse(file: FileContent, date: string, created: boolean): DailyNoteResponse {
  return {
    path: file.path,
    content: file.content,
    version: file.version,
    mtime: file.mtime,
    date,
    created,
  };
}
