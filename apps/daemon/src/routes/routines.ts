import type { AgentRuntime } from "@ddl/agent";
import { CreateRoutineRequestSchema } from "@ddl/contract";
import {
  API_ROUTES,
  ROUTINE_TEMPLATES,
  type Routine,
  type RoutineListResponse,
  type RoutineResponse,
  type RoutineRunResponse,
} from "@ddl/core";
import type { Context, Hono } from "hono";
import type { AppContext } from "../context";
import { ApiError, errorMessage, isNamedError } from "../errors";
import { idParam, readJson } from "../http-utils";

/**
 * Routines: listing, creating, pausing and resuming only touch their files (`Routines/*.md`), so
 * they work whether or not the agent runs here; running one needs the agent (503 otherwise).
 */
export function registerRoutineRoutes(app: Hono, ctx: AppContext): void {
  const { runtime } = ctx;

  app.get(API_ROUTES.routines, (c) => {
    const body: RoutineListResponse = {
      routines: runtime.listRoutines(),
      templates: [...ROUTINE_TEMPLATES],
    };
    return c.json(body);
  });

  app.post(API_ROUTES.routines, async (c) => {
    const input = await readJson(c, CreateRoutineRequestSchema);
    const body: RoutineResponse = { routine: await runtime.createRoutine(input) };
    return c.json(body, 201);
  });

  app.get("/api/routines/:id", (c) => {
    const body: RoutineResponse = { routine: requireRoutine(runtime, idParam(c, "id")) };
    return c.json(body);
  });

  app.post("/api/routines/:id/run", async (c) => {
    const id = idParam(c, "id");
    requireRoutine(runtime, id);
    let body: RoutineRunResponse;
    try {
      body = await runtime.runRoutine(id);
    } catch (error) {
      // Whatever keeps a known routine from starting now (a run going, a problem in its file,
      // today's extra runs used up) is a conflict with its current state, not a bad request.
      if (isNamedError(error, "RoutineInputError") || isNamedError(error, "RoutineConflictError")) {
        throw new ApiError(409, "conflict", errorMessage(error));
      }
      throw error;
    }
    return c.json(body);
  });

  app.post("/api/routines/:id/pause", (c) => setPaused(c, runtime, true));
  app.post("/api/routines/:id/resume", (c) => setPaused(c, runtime, false));
}

async function setPaused(c: Context, runtime: AgentRuntime, paused: boolean): Promise<Response> {
  const id = idParam(c, "id");
  requireRoutine(runtime, id);
  const body: RoutineResponse = { routine: await runtime.setRoutinePaused(id, paused) };
  return c.json(body);
}

function requireRoutine(runtime: AgentRuntime, id: string): Routine {
  const routine = runtime.getRoutine(id);
  if (!routine) throw new ApiError(404, "not_found", "Routine not found");
  return routine;
}
