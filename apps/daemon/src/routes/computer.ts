import { ComputerPermissionsOpenRequestSchema } from "@ddl/contract";
import { API_ROUTES, type OkResponse } from "@ddl/core";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { ApiError, errorMessage } from "../errors";
import { readJson } from "../http-utils";

export function registerComputerRoutes(app: Hono, ctx: AppContext): void {
  // Only fixed deep links are opened (see system-settings.ts): the body just picks the pane.
  app.post(API_ROUTES.computerPermissionsOpen, async (c) => {
    const { pane } = await readJson(c, ComputerPermissionsOpenRequestSchema);
    let outcome: "opened" | "unsupported";
    try {
      outcome = await ctx.systemSettings.open(pane);
    } catch (error) {
      ctx.logger.warn("Couldn't open System Settings", { pane, error: errorMessage(error) });
      throw new ApiError(500, "internal_error", "System Settings didn't open");
    }
    if (outcome === "unsupported") {
      throw new ApiError(404, "not_found", "System Settings exists only on macOS");
    }
    ctx.logger.info("Opened System Settings", { pane });
    const body: OkResponse = { ok: true };
    return c.json(body);
  });
}
