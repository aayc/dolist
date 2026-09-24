import {
  API_ROUTES,
  API_VERSION,
  type HealthResponse,
  isHiddenPath,
  type SearchResponse,
  type VaultEntry,
  type VaultTreeResponse,
} from "@ddl/core";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { ApiError } from "../errors";

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const MAX_QUERY_LENGTH = 500;

export function registerVaultRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_ROUTES.health, (c) => {
    const body: HealthResponse = {
      ok: true,
      version: ctx.version,
      apiVersion: API_VERSION,
      vaultName: ctx.storage.displayName,
      agentMode: ctx.runtime.mode,
    };
    return c.json(body);
  });

  app.get(API_ROUTES.tree, async (c) => {
    const [files, folders] = await Promise.all([ctx.storage.list(), ctx.storage.listFolders()]);
    const entries: VaultEntry[] = [];
    for (const path of folders) {
      if (!isHiddenPath(path)) entries.push({ path, kind: "folder" });
    }
    for (const file of files) {
      if (isHiddenPath(file.path)) continue;
      entries.push({
        path: file.path,
        kind: "file",
        size: file.size,
        mtime: file.mtime,
        version: file.version,
      });
    }
    const body: VaultTreeResponse = { vaultName: ctx.storage.displayName, entries };
    return c.json(body);
  });

  app.get("/api/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    if (query.length > MAX_QUERY_LENGTH) {
      throw new ApiError(400, "invalid_request", "Search query is too long");
    }
    const limit = parseLimit(c.req.query("limit"));
    const body: SearchResponse = { hits: query ? await ctx.search(query, limit) : [] };
    return c.json(body);
  });
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ApiError(400, "invalid_request", "limit must be a positive integer");
  }
  return Math.min(limit, MAX_SEARCH_LIMIT);
}
