import { API_CONTRACT } from "@ddl/contract";
import {
  API_PATHS,
  type DailyNoteResponse,
  parseISODate,
  today,
  toISODate,
  WORKSPACE_ID_HEADER,
} from "@ddl/core";
import type { FileContent } from "@ddl/storage";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { appendDailyCapture } from "../daily-capture";
import { renderDailyNote, resolveDailyPath } from "../daily-note";
import { ApiError, isNamedError } from "../errors";
import { clientWriteSource, isTruthyFlag, readJson } from "../http-utils";
import { principalOf } from "../security";

export function registerDailyRoutes(app: Hono, ctx: AppContext): void {
  app.post(API_PATHS.dailyAppend, async (c) => {
    if (!c.req.header(WORKSPACE_ID_HEADER))
      throw new ApiError(400, "invalid_request", "Capture requires X-DDL-Workspace-Id");
    const param = API_CONTRACT.dailyAppend.params.safeParse({ date: c.req.param("date") });
    const date = param.success ? parseISODate(param.data.date) : null;
    if (!date)
      throw new ApiError(400, "invalid_request", "Capture requires an explicit YYYY-MM-DD date");
    const request = await readJson(c, API_CONTRACT.dailyAppend.methods.POST.body);
    const principal = principalOf(c);
    if (!principal)
      throw new ApiError(401, "unauthorized", "Capture needs an authenticated principal");
    return c.json(await appendDailyCapture(ctx, date, request, principal, clientWriteSource(c)));
  });
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
