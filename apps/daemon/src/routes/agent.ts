import type { AgentRuntime } from "@ddl/agent";
import {
  API_ROUTES,
  type ApprovalListResponse,
  type ApprovalRequest,
  type ApprovalStatus,
  type TaskRecordsResponse,
  type ThreadListResponse,
  type ThreadResponse,
} from "@ddl/core";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context";
import { ApiError, errorMessage, toApiError } from "../errors";
import { idParam, readJson } from "../http-utils";
import { resolveNotePath } from "../vault-paths";
import { applySettings } from "./settings";

/** Thread actions that are still running after this long answer 202 and finish in the background. */
const ACTION_GRACE_MS = 3_000;

const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
] as const satisfies readonly ApprovalStatus[];

const SetEnabledSchema = z.strictObject({ enabled: z.boolean() });
const PostMessageSchema = z.strictObject({ text: z.string().trim().min(1).max(20_000) });
const ApprovalDecisionSchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  scope: z.enum(["once", "task", "always"]).optional(),
  note: z.string().max(2_000).optional(),
});
const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);

export function registerAgentRoutes(app: Hono, ctx: AppContext): void {
  const { runtime } = ctx;

  app.get(API_ROUTES.agentStatus, (c) => c.json(runtime.status()));

  // Persisted as `agent.enabled` so the switch survives restarts and syncs with the vault.
  app.on(["PUT", "POST"], API_ROUTES.agentEnabled, async (c) => {
    const { enabled } = await readJson(c, SetEnabledSchema);
    await applySettings(ctx, { agent: { enabled } });
    return c.json(runtime.status());
  });

  app.get("/api/tasks", (c) => {
    const notePath = c.req.query("notePath");
    if (!notePath) throw new ApiError(400, "invalid_request", "notePath is required");
    const body: TaskRecordsResponse = {
      records: runtime.getTaskRecords(resolveNotePath(notePath)),
    };
    return c.json(body);
  });

  app.get(API_ROUTES.threads, (c) => {
    const notePath = c.req.query("notePath");
    const taskId = c.req.query("taskId");
    const filter = {
      ...(notePath ? { notePath: resolveNotePath(notePath) } : {}),
      ...(taskId ? { taskId } : {}),
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
    const { text } = await readJson(c, PostMessageSchema);
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
    const status = c.req.query("status");
    let approvals: ApprovalRequest[];
    if (status === undefined) {
      approvals = runtime.listApprovals();
    } else {
      const parsed = ApprovalStatusSchema.safeParse(status);
      if (!parsed.success) throw new ApiError(400, "invalid_request", "Unknown approval status");
      approvals = runtime.listApprovals({ status: parsed.data });
    }
    const body: ApprovalListResponse = { approvals };
    return c.json(body);
  });

  app.get("/api/approvals/:id", (c) =>
    c.json({ approval: requireApproval(runtime, idParam(c, "id")) }),
  );

  app.post("/api/approvals/:id", async (c) => {
    const id = idParam(c, "id");
    const decision = await readJson(c, ApprovalDecisionSchema);
    assertPending(requireApproval(runtime, id));
    try {
      const approval = await runtime.decideApproval(id, decision);
      return c.json({ approval });
    } catch (error) {
      // Decided or expired concurrently (another tab, timeout): report the real state.
      assertPending(requireApproval(runtime, id));
      throw agentError(error);
    }
  });

  app.get(API_ROUTES.connectors, (c) =>
    c.json({ connectors: ctx.connectors?.status() ?? runtime.status().connectors }),
  );
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
      return c.json({ ok: true, pending: true }, 202);
    }
    return c.json({ ok: true });
  } catch (error) {
    throw agentError(error);
  } finally {
    clearTimeout(timer);
  }
}
