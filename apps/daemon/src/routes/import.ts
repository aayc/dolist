/**
 * Importing an Obsidian vault and switching vaults. These reach folders on this machine, so only
 * this machine may call them (the master token); a paired device gets 403 `forbidden_device`.
 * They aren't agent tools, and the safety rules deny agents any call to the daemon's API.
 */
import {
  DeviceVaultRequestSchema,
  ObsidianImportPreviewRequestSchema,
  ObsidianImportRequestSchema,
} from "@ddl/contract";
import type {
  DeviceVaultResponse,
  ObsidianImportJobResponse,
  ObsidianImportPreview,
  ObsidianImportStatusResponse,
} from "@ddl/core";
import { API_ROUTES } from "@ddl/core";
import type { Context, Hono } from "hono";
import type { AppContext } from "../context";
import { ApiError } from "../errors";
import { readJson } from "../http-utils";
import { principalOf } from "../security";

function thisMachineOnly(c: Context): void {
  if (principalOf(c)?.kind === "device") {
    throw new ApiError(
      403,
      "forbidden_device",
      "Only this machine can import vaults or switch them, not a paired device",
    );
  }
}

export function registerImportRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_ROUTES.deviceVault, (c) => {
    thisMachineOnly(c);
    const body: DeviceVaultResponse = ctx.vault.response();
    return c.json(body);
  });

  app.put(API_ROUTES.deviceVault, async (c) => {
    thisMachineOnly(c);
    const { path } = await readJson(c, DeviceVaultRequestSchema);
    const body: DeviceVaultResponse = await ctx.vault.switchTo(path);
    return c.json(body);
  });

  app.post(API_ROUTES.importObsidianPreview, async (c) => {
    thisMachineOnly(c);
    const { source } = await readJson(c, ObsidianImportPreviewRequestSchema);
    const body: ObsidianImportPreview = await ctx.imports.preview(source);
    return c.json(body);
  });

  app.get(API_ROUTES.importObsidian, (c) => {
    thisMachineOnly(c);
    const body: ObsidianImportStatusResponse = { job: ctx.imports.status() };
    return c.json(body);
  });

  app.post(API_ROUTES.importObsidian, async (c) => {
    thisMachineOnly(c);
    const request = await readJson(c, ObsidianImportRequestSchema);
    const body: ObsidianImportJobResponse = { job: await ctx.imports.startImport(request) };
    return c.json(body, 202);
  });

  app.post(API_ROUTES.importObsidianCancel, async (c) => {
    thisMachineOnly(c);
    const body: ObsidianImportJobResponse = { job: await ctx.imports.cancel() };
    return c.json(body);
  });

  app.post(API_ROUTES.importObsidianUpdate, async (c) => {
    thisMachineOnly(c);
    const body: ObsidianImportJobResponse = { job: await ctx.imports.startUpdate() };
    return c.json(body, 202);
  });
}
