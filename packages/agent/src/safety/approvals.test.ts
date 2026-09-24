import { type ApprovalRequest, DEFAULT_SETTINGS } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { describe, expect, it } from "vitest";
import { APPROVALS_STATE_PATH, MAX_PERSISTED_DECIDED, parseApprovalState } from "./approval-store";
import {
  ApprovalNotFoundError,
  ApprovalStateError,
  createApprovalBroker,
  type PersistentApprovalBroker,
} from "./approvals";
import type { NewApproval } from "./types";

function newApproval(extra: Partial<NewApproval> = {}): NewApproval {
  return {
    threadId: "thread-1",
    taskId: "task-1",
    toolName: "browser_click",
    input: { element: "Place order" },
    summary: "Click “Place order” in the browser",
    risk: "high",
    categories: ["payment"],
    reason: "Completes a purchase or payment",
    ...extra,
  };
}

/** Starts a request and returns its outcome promise plus the created approval. */
function start(
  broker: PersistentApprovalBroker,
  extra: Partial<NewApproval> = {},
  signal?: AbortSignal,
) {
  const outcome = broker.request(newApproval(extra), signal);
  const approval = broker.list().at(-1)!;
  return { outcome, approval };
}

describe("request and decide", () => {
  it("creates a pending approval, emits it and resolves once approved", async () => {
    const broker = createApprovalBroker({ now: () => 1_000 });
    const seen: ApprovalRequest[] = [];
    broker.onUpsert((a) => seen.push(a));
    const { outcome, approval } = start(broker);
    expect(approval).toMatchObject({
      status: "pending",
      toolName: "browser_click",
      categories: ["payment"],
      createdAt: 1_000,
      expiresAt: 1_000 + DEFAULT_SETTINGS.agent.approvalTimeoutMs,
    });
    expect(approval.id).toMatch(/^apr_/);
    const decided = await broker.decide(approval.id, { decision: "approve" });
    expect(decided).toMatchObject({ status: "approved", scope: "once", decidedAt: 1_000 });
    await expect(outcome).resolves.toMatchObject({
      approved: true,
      request: { status: "approved" },
    });
    expect(seen.map((a) => a.status)).toEqual(["pending", "approved"]);
  });

  it("resolves denials with the user's note", async () => {
    const broker = createApprovalBroker();
    const { outcome, approval } = start(broker);
    await broker.decide(approval.id, { decision: "deny", note: " too expensive " });
    await expect(outcome).resolves.toMatchObject({
      approved: false,
      note: "too expensive",
      request: { status: "denied", decisionNote: "too expensive" },
    });
  });

  it("rejects decisions on unknown, decided or malformed approvals", async () => {
    const broker = createApprovalBroker();
    const { approval } = start(broker);
    await expect(broker.decide("apr_missing", { decision: "approve" })).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
    await expect(broker.decide(approval.id, { decision: "maybe" as never })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      broker.decide(approval.id, { decision: "approve", scope: "forever" as never }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(broker.get(approval.id)?.status).toBe("pending");
    await broker.decide(approval.id, { decision: "deny" });
    const error = await broker
      .decide(approval.id, { decision: "approve" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApprovalStateError);
    expect((error as ApprovalStateError).status).toBe("denied");
  });

  it("expires approvals nobody answers", async () => {
    const broker = createApprovalBroker({ defaultTimeoutMs: 10 });
    const { outcome } = start(broker);
    await expect(outcome).resolves.toMatchObject({
      approved: false,
      request: { status: "expired" },
    });
    const custom = start(broker, { timeoutMs: 5 });
    await expect(custom.outcome).resolves.toMatchObject({ request: { status: "expired" } });
  });

  it("cancels approvals when the agent aborts", async () => {
    const broker = createApprovalBroker();
    const controller = new AbortController();
    const { outcome, approval } = start(broker, {}, controller.signal);
    controller.abort();
    await expect(outcome).resolves.toMatchObject({
      approved: false,
      request: { status: "cancelled" },
    });
    expect(broker.get(approval.id)?.status).toBe("cancelled");
    const aborted = new AbortController();
    aborted.abort();
    await expect(start(broker, {}, aborted.signal).outcome).resolves.toMatchObject({
      request: { status: "cancelled" },
    });
  });

  it("cancels every pending approval of a task", async () => {
    const broker = createApprovalBroker();
    const a = start(broker);
    const b = start(broker, { toolName: "bash" });
    const other = start(broker, { taskId: "task-2" });
    broker.cancelForTask("task-1", "The task was deleted.");
    await expect(a.outcome).resolves.toMatchObject({
      approved: false,
      note: "The task was deleted.",
    });
    await expect(b.outcome).resolves.toMatchObject({ request: { status: "cancelled" } });
    expect(broker.get(other.approval.id)?.status).toBe("pending");
  });

  it("lists, filters and isolates listener failures", async () => {
    const broker = createApprovalBroker();
    broker.onUpsert(() => {
      throw new Error("listener bug");
    });
    const seen: string[] = [];
    const off = broker.onUpsert((a) => seen.push(a.status));
    const a = start(broker);
    start(broker, { threadId: "thread-2", taskId: "task-2" });
    off();
    await broker.decide(a.approval.id, { decision: "approve" });
    expect(seen).toEqual(["pending", "pending"]);
    expect(broker.list({ status: "pending" })).toHaveLength(1);
    expect(broker.list({ threadId: "thread-2" })).toHaveLength(1);
    expect(broker.list({ taskId: "task-1", status: "approved" })).toHaveLength(1);
    expect(broker.get(a.approval.id)?.status).toBe("approved");
  });
});

describe("standing grants", () => {
  it("records task grants that cover the same tool in the same task only", async () => {
    const broker = createApprovalBroker();
    const { approval } = start(broker);
    await broker.decide(approval.id, { decision: "approve", scope: "task" });
    expect(broker.findGrant({ toolName: "browser_click", taskId: "task-1" })).toMatchObject({
      scope: "task",
      taskId: "task-1",
    });
    expect(broker.findGrant({ toolName: "browser_click", taskId: "task-2" })).toBeUndefined();
    expect(broker.findGrant({ toolName: "browser_click", taskId: null })).toBeUndefined();
    expect(broker.findGrant({ toolName: "browser_type", taskId: "task-1" })).toBeUndefined();
  });

  it("records always grants for the tool across tasks", async () => {
    const broker = createApprovalBroker();
    const { approval } = start(broker, {
      toolName: "mcp__gmail__send_email",
      categories: ["communication"],
    });
    await broker.decide(approval.id, { decision: "approve", scope: "always" });
    expect(
      broker.findGrant({ toolName: "mcp__gmail__send_email", taskId: "task-9" }),
    ).toMatchObject({ scope: "always", taskId: null });
    expect(broker.findGrant({ toolName: "mcp__gmail__send_email", taskId: null })).toBeDefined();
  });

  it("only covers actions with the approved categories and no more risk", async () => {
    const broker = createApprovalBroker();
    const { approval } = start(broker, { categories: ["form_submission"], risk: "medium" });
    await broker.decide(approval.id, { decision: "approve", scope: "task" });
    const query = { toolName: "browser_click", taskId: "task-1" };
    expect(
      broker.findGrant({ ...query, categories: ["form_submission"], risk: "medium" }),
    ).toBeDefined();
    expect(
      broker.findGrant({ ...query, categories: ["form_submission"], risk: "low" }),
    ).toBeDefined();
    expect(broker.findGrant({ ...query, categories: ["payment"], risk: "medium" })).toBeUndefined();
    expect(
      broker.findGrant({ ...query, categories: ["form_submission", "payment"], risk: "medium" }),
    ).toBeUndefined();
    expect(
      broker.findGrant({ ...query, categories: ["form_submission"], risk: "high" }),
    ).toBeUndefined();
  });

  it("treats a task grant without a task as a one-time approval", async () => {
    const broker = createApprovalBroker();
    const { approval } = start(broker, { taskId: null });
    const decided = await broker.decide(approval.id, { decision: "approve", scope: "task" });
    expect(decided.scope).toBe("once");
    expect(broker.findGrant({ toolName: "browser_click", taskId: null })).toBeUndefined();
  });

  it("never grants anything on denial", async () => {
    const broker = createApprovalBroker();
    const { approval } = start(broker);
    await broker.decide(approval.id, { decision: "deny", scope: "always" });
    expect(broker.findGrant({ toolName: "browser_click", taskId: "task-1" })).toBeUndefined();
  });
});

describe("persistence", () => {
  it("round-trips grants and history and expires approvals left pending by a previous process", async () => {
    const storage = new MemoryStorageProvider();
    const first = createApprovalBroker({ storage, now: () => 5_000 });
    await first.ready;
    const approved = start(first);
    await first.decide(approved.approval.id, { decision: "approve", scope: "task" });
    const stale = start(first, { toolName: "bash", taskId: "task-2", categories: ["system"] });
    await first.flush();

    const saved = parseApprovalState((await storage.read(APPROVALS_STATE_PATH))!.content)!;
    expect(saved.grants).toHaveLength(1);
    expect(saved.approvals.map((a) => a.status).sort()).toEqual(["approved", "pending"]);

    const second = createApprovalBroker({ storage, now: () => 9_000 });
    const events: ApprovalRequest[] = [];
    second.onUpsert((a) => events.push(a));
    await second.ready;
    expect(
      second.findGrant({
        toolName: "browser_click",
        taskId: "task-1",
        categories: ["payment"],
        risk: "high",
      }),
    ).toBeDefined();
    expect(second.get(approved.approval.id)?.status).toBe("approved");
    expect(second.get(stale.approval.id)).toMatchObject({ status: "expired", decidedAt: 9_000 });
    expect(events.map((e) => [e.id, e.status])).toEqual([[stale.approval.id, "expired"]]);
    await expect(second.decide(stale.approval.id, { decision: "approve" })).rejects.toBeInstanceOf(
      ApprovalStateError,
    );

    await second.flush();
    const rewritten = parseApprovalState((await storage.read(APPROVALS_STATE_PATH))!.content)!;
    expect(rewritten.approvals.find((a) => a.id === stale.approval.id)?.status).toBe("expired");
  });

  it("ignores unreadable files and drops malformed entries", async () => {
    const broken = new MemoryStorageProvider({
      initialFiles: { [APPROVALS_STATE_PATH]: "{not json" },
    });
    const a = createApprovalBroker({ storage: broken });
    await a.ready;
    expect(a.list()).toEqual([]);

    const partial = JSON.stringify({
      version: 1,
      grants: [
        { toolName: "bash", scope: "always", taskId: null, createdAt: 1 },
        { toolName: 42 },
        { toolName: "x", scope: "task", taskId: null, createdAt: 1 },
      ],
      approvals: [{ id: "apr_bad" }],
    });
    const b = createApprovalBroker({
      storage: new MemoryStorageProvider({ initialFiles: { [APPROVALS_STATE_PATH]: partial } }),
    });
    await b.ready;
    expect(b.findGrant({ toolName: "bash", taskId: "task-1" })).toMatchObject({ scope: "always" });
    expect(b.findGrant({ toolName: "x", taskId: null })).toBeUndefined();
    expect(b.list()).toEqual([]);
  });

  it("keeps only the most recent decided approvals on disk", async () => {
    const storage = new MemoryStorageProvider();
    let clock = 0;
    const broker = createApprovalBroker({ storage, now: () => ++clock });
    for (let i = 0; i < MAX_PERSISTED_DECIDED + 5; i++) {
      const { approval } = start(broker);
      await broker.decide(approval.id, { decision: "deny" });
    }
    await broker.flush();
    const saved = parseApprovalState((await storage.read(APPROVALS_STATE_PATH))!.content)!;
    expect(saved.approvals).toHaveLength(MAX_PERSISTED_DECIDED);
  });

  it("releases waiting agents on dispose", async () => {
    const broker = createApprovalBroker({ storage: new MemoryStorageProvider() });
    const { outcome, approval } = start(broker);
    await broker.dispose();
    await expect(outcome).resolves.toMatchObject({ approved: false });
    expect(broker.get(approval.id)?.status).toBe("pending");
  });
});
