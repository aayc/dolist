import {
  API_ROUTES,
  type ConflictResponse,
  type NoteResponse,
  type TrashResponse,
  type WriteNoteResponse,
} from "@ddl/core";
import type { FileContent, StorageProvider, WriteOptions, WriteResult } from "@ddl/storage";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context";
import { ApiError, isNamedError } from "../errors";
import { clientWriteSource, readJson } from "../http-utils";
import {
  folderExists,
  type MovedFile,
  moveFolder,
  moveFolderToTrash,
  moveNoteToTrash,
} from "../vault-ops";
import { notePathFromUrl, resolveNotePath, resolveVaultPath } from "../vault-paths";

const MAX_NOTE_CHARS = 5 * 1024 * 1024;

const WriteNoteSchema = z.strictObject({
  content: z.string().max(MAX_NOTE_CHARS),
  baseVersion: z.string().min(1).max(256).nullable().optional(),
});

const RenameSchema = z.strictObject({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
});

const CreateFolderSchema = z.strictObject({ path: z.string().min(1).max(1024) });

export function registerNoteRoutes(app: Hono, ctx: AppContext): void {
  app.get("/api/notes/*", async (c) => {
    const path = notePathFromUrl(c.req.url);
    const note = await ctx.storage.read(path);
    if (!note) throw new ApiError(404, "not_found", `No note at "${path}"`);
    return c.json(toNoteResponse(note));
  });

  app.put("/api/notes/*", async (c) => {
    const path = notePathFromUrl(c.req.url);
    const body = await readJson(c, WriteNoteSchema);
    // `null` = create only; omitted = unconditional overwrite.
    const options: WriteOptions =
      body.baseVersion === undefined ? {} : { ifMatch: body.baseVersion };
    let result: WriteResult;
    try {
      result = await ctx.storage.write(path, body.content, options);
    } catch (error) {
      if (isNamedError(error, "ConflictError")) return conflict(c, ctx.storage, path);
      throw error;
    }
    ctx.writes.record(result.path, result.version, clientWriteSource(c));
    const response: WriteNoteResponse = {
      path: result.path,
      version: result.version,
      mtime: result.mtime,
    };
    return c.json(response, result.created ? 201 : 200);
  });

  app.delete("/api/notes/*", async (c) => {
    const path = notePathFromUrl(c.req.url);
    if (!(await ctx.storage.stat(path)))
      throw new ApiError(404, "not_found", `No note at "${path}"`);
    const moved = await moveNoteToTrash(ctx.storage, path);
    recordMoves(ctx, c, [moved]);
    const response: TrashResponse = { ok: true, trashedTo: moved.to };
    return c.json(response);
  });

  app.post(API_ROUTES.rename, async (c) => {
    const body = await readJson(c, RenameSchema);
    const fromFolder = resolveVaultPath(body.from);
    if (await folderExists(ctx.storage, fromFolder)) {
      return renameFolder(c, ctx, fromFolder, resolveVaultPath(body.to));
    }
    const from = resolveNotePath(body.from);
    const to = resolveNotePath(body.to);
    if (from === to) throw new ApiError(400, "invalid_request", "Source and target are the same");
    let result: WriteResult;
    try {
      result = await ctx.storage.rename(from, to);
    } catch (error) {
      if (isNamedError(error, "ConflictError")) return conflict(c, ctx.storage, to);
      throw error;
    }
    const source = clientWriteSource(c);
    ctx.writes.record(from, undefined, source);
    ctx.writes.record(result.path, result.version, source);
    const response: WriteNoteResponse = {
      path: result.path,
      version: result.version,
      mtime: result.mtime,
    };
    return c.json(response);
  });

  app.post(API_ROUTES.folders, async (c) => {
    const body = await readJson(c, CreateFolderSchema);
    const path = resolveVaultPath(body.path);
    await ctx.storage.createFolder(path);
    return c.json({ path }, 201);
  });

  app.delete(API_ROUTES.folders, async (c) => {
    const path = resolveVaultPath(c.req.query("path") ?? "");
    let moved: MovedFile[];
    try {
      moved = await moveFolderToTrash(ctx.storage, path);
    } catch (error) {
      if (isNamedError(error, "NotFoundError")) {
        throw new ApiError(404, "not_found", `No folder at "${path}"`);
      }
      throw error;
    }
    recordMoves(ctx, c, moved);
    const response: TrashResponse = { ok: true, trashedTo: joinTrash(path, moved) };
    return c.json(response);
  });
}

async function renameFolder(
  c: Context,
  ctx: AppContext,
  from: string,
  to: string,
): Promise<Response> {
  if (from === to) throw new ApiError(400, "invalid_request", "Source and target are the same");
  let moved: MovedFile[];
  try {
    moved = await moveFolder(ctx.storage, from, to);
  } catch (error) {
    if (isNamedError(error, "ConflictError")) {
      throw new ApiError(409, "conflict", `"${to}" already exists or is inside "${from}"`);
    }
    throw error;
  }
  recordMoves(ctx, c, moved);
  return c.json({ path: to, moved: moved.length });
}

function recordMoves(ctx: AppContext, c: Context, moved: readonly MovedFile[]): void {
  const source = clientWriteSource(c);
  for (const file of moved) {
    ctx.writes.record(file.from, undefined, source);
    ctx.writes.record(file.to, file.version, source);
  }
}

function joinTrash(folder: string, moved: readonly MovedFile[]): string {
  const first = moved[0];
  return first ? first.to.slice(0, first.to.length - (first.from.length - folder.length)) : "";
}

export function toNoteResponse(file: FileContent): NoteResponse {
  return { path: file.path, content: file.content, version: file.version, mtime: file.mtime };
}

async function conflict(c: Context, storage: StorageProvider, path: string): Promise<Response> {
  const current = await storage.read(path);
  const body: ConflictResponse = {
    error: "conflict",
    current: current ? toNoteResponse(current) : null,
  };
  return c.json(body, 409);
}
