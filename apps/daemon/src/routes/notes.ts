import {
  API_CONTRACT,
  CreateFolderRequestSchema,
  RenameRequestSchema,
  WriteNoteRequestSchema,
} from "@ddl/contract";
import {
  API_PATHS,
  type ConflictResponse,
  type CreateFolderResponse,
  type FolderRenameResponse,
  joinPath,
  type NoteResponse,
  type TrashResponse,
  type WriteNoteResponse,
} from "@ddl/core";
import type { FileContent, StorageProvider, WriteOptions, WriteResult } from "@ddl/storage";
import type { Context, Hono } from "hono";
import type { AppContext } from "../context";
import { ApiError, isNamedError } from "../errors";
import { clientWriteSource, readJson, readQuery } from "../http-utils";
import {
  folderExists,
  type MovedFile,
  moveFolder,
  moveFolderToTrash,
  moveNoteToTrash,
  TRASH_DIR,
  trashCandidate,
} from "../vault-ops";
import { notePathFromUrl, resolveNotePath, resolveVaultPath } from "../vault-paths";

export function registerNoteRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_PATHS.note, async (c) => {
    const path = notePathFromUrl(c.req.url);
    const note = await ctx.storage.read(path);
    if (!note) throw new ApiError(404, "not_found", `No note at "${path}"`);
    return c.json(toNoteResponse(note));
  });

  app.put(API_PATHS.note, async (c) => {
    const path = notePathFromUrl(c.req.url);
    const body = await readJson(c, WriteNoteRequestSchema);
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

  app.delete(API_PATHS.note, async (c) => {
    const path = notePathFromUrl(c.req.url);
    if (!(await ctx.storage.stat(path)))
      throw new ApiError(404, "not_found", `No note at "${path}"`);
    const moved = await moveNoteToTrash(ctx.storage, path, ctx.now());
    recordMoves(ctx, c, [moved]);
    const response: TrashResponse = { ok: true, trashedTo: moved.to };
    return c.json(response);
  });

  app.post(API_PATHS.rename, async (c) => {
    const body = await readJson(c, RenameRequestSchema);
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

  app.post(API_PATHS.folders, async (c) => {
    const body = await readJson(c, CreateFolderRequestSchema);
    const path = resolveVaultPath(body.path);
    await ctx.storage.createFolder(path);
    const response: CreateFolderResponse = { path };
    return c.json(response, 201);
  });

  app.delete(API_PATHS.folders, async (c) => {
    const query = readQuery(c, API_CONTRACT.folders.methods.DELETE.query);
    const path = resolveVaultPath(query.path);
    const now = ctx.now();
    let moved: MovedFile[];
    try {
      moved = await moveFolderToTrash(ctx.storage, path, now);
    } catch (error) {
      if (isNamedError(error, "NotFoundError")) {
        throw new ApiError(404, "not_found", `No folder at "${path}"`);
      }
      throw error;
    }
    recordMoves(ctx, c, moved);
    const trashedTo =
      moved.length > 0 ? joinTrash(path, moved) : await emptyFolderTrash(ctx.storage, path, now);
    const response: TrashResponse = { ok: true, trashedTo };
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
  // moveFolder would merge into an existing folder; a rename must not.
  if (from.toLowerCase() !== to.toLowerCase() && (await folderExists(ctx.storage, to))) {
    throw new ApiError(409, "conflict", `"${to}" already exists`);
  }
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
  const response: FolderRenameResponse = { path: to, moved: moved.length };
  return c.json(response);
}

function recordMoves(ctx: AppContext, c: Context, moved: readonly MovedFile[]): void {
  const source = clientWriteSource(c);
  for (const file of moved) {
    ctx.writes.record(file.from, undefined, source);
    ctx.writes.record(file.to, file.version, source);
  }
}

function joinTrash(folder: string, moved: readonly MovedFile[]): string {
  const first = moved[0]!;
  return first.to.slice(0, first.to.length - (first.from.length - folder.length));
}

/**
 * Where `moveFolderToTrash` put an empty folder (no moved files to derive it from): its first
 * candidate that is now a folder without files.
 */
async function emptyFolderTrash(storage: StorageProvider, folder: string, now: Date) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const to = trashCandidate(folder, true, now, attempt);
    if (!(await folderExists(storage, to))) continue;
    if ((await storage.list({ prefix: to, includeHidden: true })).length === 0) return to;
  }
  return joinPath(TRASH_DIR, folder);
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
