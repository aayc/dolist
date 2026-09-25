import { MachinePairRequestSchema } from "@ddl/contract";
import { API_ROUTES, type MachineStatusResponse } from "@ddl/core";
import type { Hono } from "hono";
import type { AppContext } from "../context";
import { readJson } from "../http-utils";

export function registerMachineRoutes(app: Hono, ctx: AppContext): void {
  app.get(API_ROUTES.machine, (c) => {
    const body: MachineStatusResponse = ctx.machine.status();
    return c.json(body);
  });

  app.post(API_ROUTES.machinePair, async (c) => {
    const request = await readJson(c, MachinePairRequestSchema);
    const body: MachineStatusResponse = await ctx.machine.pair(request);
    return c.json(body);
  });

  app.post(API_ROUTES.machineCheck, async (c) => {
    const body: MachineStatusResponse = await ctx.machine.check();
    return c.json(body);
  });

  app.delete(API_ROUTES.machinePairing, async (c) => {
    const body: MachineStatusResponse = await ctx.machine.unpair();
    return c.json(body);
  });
}
