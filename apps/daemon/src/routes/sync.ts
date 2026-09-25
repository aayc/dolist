import { API_ROUTES, type SyncStatusResponse } from "@ddl/core";
import { disabledSyncStatus, type SyncStatus } from "@ddl/storage";
import type { Hono } from "hono";
import type { AppContext } from "../context";

export function registerSyncRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_ROUTES.syncStatus, (c) => c.json(ctx.syncStatus()));
}

/** The wire shape of the engine's status, plus the remote server and this device's name. */
export function toSyncStatusResponse(
  status: SyncStatus,
  remote?: { host: string; deviceName: string },
): SyncStatusResponse {
  return {
    state: status.state,
    target: status.target,
    lastSyncedAt: status.lastSyncedAt,
    pendingChanges: status.pendingChanges,
    conflicts: [...status.conflicts],
    ...(status.lastError ? { lastError: status.lastError } : {}),
    ...(remote ? { remoteHost: remote.host, deviceName: remote.deviceName } : {}),
  };
}

export function disabledSyncStatusResponse(): SyncStatusResponse {
  return toSyncStatusResponse(disabledSyncStatus());
}
