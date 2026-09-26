import { API_CONTRACT, WIRE_LIMITS } from "@ddl/contract";
import {
  API_PATHS,
  API_VERSION,
  type HealthResponse,
  isHiddenPath,
  type SearchResponse,
  type VaultEntry,
  type VaultTreeResponse,
} from "@ddl/core";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { readQuery } from "../http-utils";

const DEFAULT_SEARCH_LIMIT = 50;

export function registerVaultRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_PATHS.health, (c) => {
    const body: HealthResponse = {
      ok: true,
      version: ctx.version,
      apiVersion: API_VERSION,
      vaultName: ctx.storage.displayName,
      agentMode: ctx.runtime.mode,
    };
    return c.json(body);
  });

  app.get(API_PATHS.tree, async (c) => {
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

  app.get(API_PATHS.search, async (c) => {
    const { q = "", limit } = readQuery(c, API_CONTRACT.search.methods.GET.query);
    const max =
      limit === undefined ? DEFAULT_SEARCH_LIMIT : Math.min(Number(limit), WIRE_LIMITS.searchLimit);
    const body: SearchResponse = { hits: q ? await ctx.search(q, max) : [] };
    return c.json(body);
  });
}
