import { ClientIdSchema } from "@ddl/contract";
import { API_PATHS, OPERATION_ID_HEADER, WORKSPACE_ID_HEADER } from "@ddl/core";
import type { Hono, MiddlewareHandler } from "hono";
import type { AgentMutations } from "./agent-mutations";
import type { AppContext } from "./context";
import { ApiError } from "./errors";
import { readJson } from "./http-utils";
import { matchRelayRoute } from "./relay/routes";

export function operationIdHeader(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!ClientIdSchema.safeParse(value).success) {
    throw new ApiError(400, "invalid_request", "Invalid operation ID");
  }
  return value;
}

/** Installed after the relay: only the authority that actually dispatches prepares a receipt. */
export function mutationMiddleware(ctx: AppContext, mutations: AgentMutations): MiddlewareHandler {
  return async (c, next) => {
    const operationId = operationIdHeader(c.req.header(OPERATION_ID_HEADER));
    if (!operationId) return next();
    const route = matchRelayRoute(c.req.method, new URL(c.req.url));
    if (route?.method !== "POST" || route.kind === "read") {
      throw new ApiError(400, "invalid_request", "This route does not support operation IDs");
    }
    if (!c.req.header(WORKSPACE_ID_HEADER)) {
      throw new ApiError(400, "invalid_request", "An operation requires a verified workspace");
    }
    const body: unknown = route.body ? await readJson(c, route.body) : null;
    if (!route.body && (await c.req.text()).trim() !== "") {
      throw new ApiError(400, "invalid_request", "This action does not accept a body");
    }
    c.res = await mutations.perform(
      await ctx.workspace.current(),
      operationId,
      route.target,
      body,
      async () => {
        await next();
        return c.res;
      },
    );
  };
}

export function registerMutationRoutes(
  app: Hono,
  ctx: AppContext,
  mutations: AgentMutations,
): void {
  app.get(API_PATHS.agentOperation, async (c) => {
    const id = operationIdHeader(c.req.param("id"));
    if (!id || !c.req.header(WORKSPACE_ID_HEADER)) {
      throw new ApiError(
        400,
        "invalid_request",
        "Receipt lookup requires an operation ID and verified workspace",
      );
    }
    return c.json(await mutations.lookup(await ctx.workspace.current(), id));
  });
}
