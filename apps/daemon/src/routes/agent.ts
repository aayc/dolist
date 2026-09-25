import type { AgentRuntime } from "@ddl/agent";
import {
  API_CONTRACT,
  ApprovalDecisionRequestSchema,
  PostMessageRequestSchema,
  SetAgentEnabledRequestSchema,
} from "@ddl/contract";
import {
  API_ROUTES,
  type ApprovalListResponse,
  type ApprovalRequest,
  type ApprovalResponse,
  type ConnectorsResponse,
  type SetAgentEnabledResponse,
  type TaskRecordsResponse,
  type ThreadActionResponse,
  type ThreadListResponse,
  type ThreadResponse,
} from "@ddl/core";
import type { Context, Hono } from "hono";
import type { AppContext } from "../context";
import { ApiError, errorMessage, toApiError } from "../errors";
import { idParam, readJson, readQuery } from "../http-utils";
import { resolveNotePath } from "../vault-paths";
import { applySettings } from "./settings";

/** Thread actions that are still running after this long answer 202 and finish in the background. */
const ACTION_GRACE_MS = 3_000;

export function registerAgentRoutes(app: Hono, ctx: AppContext): void {
  const { runtime } = ctx;

  app.get(API_ROUTES.agentStatus, (c) => c.json(runtime.status()));

  // Persisted as `agent.enabled` so the switch survives restarts and syncs with the vault.
  app.on(["PUT", "POST"], API_ROUTES.agentEnabled, async (c) => {
    const { enabled } = await readJson(c, SetAgentEnabledRequestSchema);
    await applySettings(ctx, { agent: { enabled } });
    const body: SetAgentEnabledResponse = runtime.status();
    return c.json(body);
  });

  app.get("/api/tasks", (c) => {
    const { notePath } = readQuery(c, API_CONTRACT.tasks.methods.GET.query);
    const body: TaskRecordsResponse = {
      records: runtime.getTaskRecords(resolveNotePath(notePath)),
    };
    return c.json(body);
  });

  app.get(API_ROUTES.threads, (c) => {
    const { notePath, taskId, routineId } = readQuery(c, API_CONTRACT.threads.methods.GET.query);
    const filter = {
      ...(notePath ? { notePath: resolveNotePath(notePath) } : {}),
      ...(taskId ? { taskId } : {}),
      ...(routineId ? { routineId } : {}),
    };
    const body: ThreadListResponse = {
      threads: runtime.listThreads(Object.keys(filter).length > 0 ? filter : undefined),
    };
    return c.json(body);
  });

  app.get("/api/threads/:id", (c) => {
    const body: ThreadResponse = requireThread(runtime, idParam(c, "id"));
    return c.json(body);
  });

  app.post("/api/threads/:id/messages", async (c) => {
    const id = idParam(c, "id");
    const { text } = await readJson(c, PostMessageRequestSchema);
    requireThread(runtime, id);
    return runAction(c, ctx, "postUserMessage", () => runtime.postUserMessage(id, text));
  });

  app.post("/api/threads/:id/cancel", (c) => {
    const id = idParam(c, "id");
    requireThread(runtime, id);
    return runAction(c, ctx, "cancelThread", () => runtime.cancelThread(id));
  });

  app.post("/api/threads/:id/retry", (c) => {
    const id = idParam(c, "id");
    requireThread(runtime, id);
    return runAction(c, ctx, "retryThread", () => runtime.retryThread(id));
  });

  app.get(API_ROUTES.approvals, (c) => {
    const { status } = readQuery(c, API_CONTRACT.approvals.methods.GET.query);
    const body: ApprovalListResponse = {
      approvals: runtime.listApprovals(status === undefined ? undefined : { status }),
    };
    return c.json(body);
  });

  app.get("/api/approvals/:id", (c) => {
    const body: ApprovalResponse = { approval: requireApproval(runtime, idParam(c, "id")) };
    return c.json(body);
  });

  app.post("/api/approvals/:id", async (c) => {
    const id = idParam(c, "id");
    const decision = await readJson(c, ApprovalDecisionRequestSchema);
    assertPending(requireApproval(runtime, id));
    try {
      const body: ApprovalResponse = { approval: await runtime.decideApproval(id, decision) };
      return c.json(body);
    } catch (error) {
      // Decided or expired concurrently (another tab, timeout): report the real state.
      assertPending(requireApproval(runtime, id));
      throw agentError(error);
    }
  });

  app.get(API_ROUTES.connectors, (c) => {
    const body: ConnectorsResponse = {
      connectors: ctx.connectors?.status() ?? runtime.status().connectors,
    };
    return c.json(body);
  });
}

function requireThread(runtime: AgentRuntime, id: string): ThreadResponse {
  const thread = runtime.getThread(id);
  if (!thread) throw new ApiError(404, "not_found", "Thread not found");
  return thread;
}

function requireApproval(runtime: AgentRuntime, id: string): ApprovalRequest {
  const approval = runtime.listApprovals().find((candidate) => candidate.id === id);
  if (!approval) throw new ApiError(404, "not_found", "Approval not found");
  return approval;
}

function assertPending(approval: ApprovalRequest): void {
  if (approval.status !== "pending") {
    throw new ApiError(409, "conflict", `Approval is already ${approval.status}`, { approval });
  }
}

/** Known runtime errors keep their mapping; anything else surfaces the runtime's message. */
function agentError(error: unknown): ApiError {
  const mapped = toApiError(error);
  return mapped.status === 500 ? new ApiError(500, "agent_error", errorMessage(error)) : mapped;
}

/**
 * Awaits a runtime action briefly so fast failures reach the client, without holding the request
 * open for however long the agent takes.
 */
async function runAction(
  c: Context,
  ctx: AppContext,
  name: string,
  action: () => Promise<void>,
): Promise<Response> {
  const promise = action();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ACTION_GRACE_MS);
  });
  try {
    const outcome = await Promise.race([promise.then(() => "done" as const), pending]);
    if (outcome === "pending") {
      promise.catch((error: unknown) => {
        ctx.logger.warn("Agent action failed", { action: name, error: errorMessage(error) });
      });
      const body: ThreadActionResponse = { ok: true, pending: true };
      return c.json(body, 202);
    }
    const body: ThreadActionResponse = { ok: true };
    return c.json(body);
  } catch (error) {
    throw agentError(error);
  } finally {
    clearTimeout(timer);
  }
}
