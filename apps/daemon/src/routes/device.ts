import { DeviceSettingsPatchSchema } from "@ddl/contract";
import { API_ROUTES, type DeviceSettingsResponse } from "@ddl/core";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { readJson } from "../http-utils";

export function registerDeviceRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_ROUTES.device, (c) => {
    const body: DeviceSettingsResponse = ctx.device.response();
    return c.json(body);
  });

  app.patch(API_ROUTES.device, async (c) => {
    const patch = await readJson(c, DeviceSettingsPatchSchema);
    const body: DeviceSettingsResponse = await ctx.device.patch(patch);
    return c.json(body);
  });
}
