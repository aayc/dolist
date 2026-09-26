import {
  API_PATHS,
  type AppSettings,
  type DeepPartial,
  errorMessage,
  type SettingsResponse,
} from "@ddl/core";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { readJson } from "../http-utils";
import { SettingsPatchSchema } from "../settings-schema";

export function registerSettingsRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_PATHS.settings, (c) => {
    const body: SettingsResponse = { settings: ctx.settings.get() };
    return c.json(body);
  });

  // PUT with a deep partial (PATCH semantics); PATCH is accepted as an alias.
  app.on(["PUT", "PATCH"], API_PATHS.settings, async (c) => {
    const patch = await readJson(c, SettingsPatchSchema);
    const body: SettingsResponse = { settings: await applySettings(ctx, patch) };
    return c.json(body);
  });
}

/**
 * Persists a settings change (broadcast by the WebSocket hub) and hands the result to the runtime.
 * `agent.enabled` is applied through `updateSettings` too, so the runtime never enables twice.
 */
export async function applySettings(
  ctx: AppContext,
  patch: DeepPartial<AppSettings>,
): Promise<AppSettings> {
  const settings = await ctx.settings.update(patch);
  try {
    ctx.runtime.updateSettings(settings);
  } catch (error) {
    ctx.logger.error("Agent runtime rejected the new settings", { error: errorMessage(error) });
  }
  return settings;
}
