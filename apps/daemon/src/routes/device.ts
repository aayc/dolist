import { DeviceSettingsPatchSchema, DeviceSyncSetupRequestSchema } from "@ddl/contract";
import { API_PATHS, type DeviceSettingsResponse } from "@ddl/core";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { readJson } from "../http-utils";

export function registerDeviceRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_PATHS.device, (c) => {
    const body: DeviceSettingsResponse = ctx.device.response();
    return c.json(body);
  });

  app.patch(API_PATHS.device, async (c) => {
    const patch = await readJson(c, DeviceSettingsPatchSchema);
    const body: DeviceSettingsResponse = await ctx.device.patch(patch);
    return c.json(body);
  });

  // Answers once the new setup runs: the old engine and lease stopped, the new ones started.
  app.put(API_PATHS.deviceSync, async (c) => {
    const request = await readJson(c, DeviceSyncSetupRequestSchema);
    const body: DeviceSettingsResponse = await ctx.device.setupSync(request);
    return c.json(body);
  });

  app.delete(API_PATHS.deviceSync, async (c) => {
    const body: DeviceSettingsResponse = await ctx.device.removeSync();
    return c.json(body);
  });
}
