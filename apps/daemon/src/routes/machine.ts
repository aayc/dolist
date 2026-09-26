import { MachinePairRequestSchema } from "@ddl/contract";
import { API_PATHS, type MachineStatusResponse } from "@ddl/core";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { readJson } from "../http-utils";

export function registerMachineRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_PATHS.machine, (c) => {
    const body: MachineStatusResponse = ctx.machine.status();
    return c.json(body);
  });

  app.post(API_PATHS.machinePair, async (c) => {
    const request = await readJson(c, MachinePairRequestSchema);
    const body: MachineStatusResponse = await ctx.machine.pair(request);
    return c.json(body);
  });

  app.post(API_PATHS.machineCheck, async (c) => {
    const body: MachineStatusResponse = await ctx.machine.check();
    return c.json(body);
  });

  app.delete(API_PATHS.machinePairing, async (c) => {
    const body: MachineStatusResponse = await ctx.machine.unpair();
    return c.json(body);
  });
}
