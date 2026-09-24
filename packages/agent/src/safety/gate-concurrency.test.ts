import type { ActionCategory, ApprovalRequest, ApprovalScope, RiskLevel } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCallRequest } from "../harness/types";
import {
  ApprovalNotFoundError,
  ApprovalStateError,
  createApprovalBroker,
  type PersistentApprovalBroker,
} from "./approvals";
import { createSafetyEvaluator } from "./evaluator";
import { createSafetyGate } from "./gate";
import { RISK_LEVELS, riskRank } from "./policy";
import { runs } from "./test-arbitraries";
import { WORKSPACE } from "./test-helpers";
import type { NewApproval } from "./types";

afterEach(() => {
  vi.useRealTimers();
});

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

function start(
  broker: PersistentApprovalBroker,
  extra: Partial<NewApproval> = {},
  signal?: AbortSignal,
) {
  const outcome = broker.request(newApproval(extra), signal);
  return { outcome, approval: broker.list().at(-1)! };
}

describe("approval broker races", () => {
  it("resolves many concurrent requests with their own decisions", async () => {
    const broker = createApprovalBroker();
    const started = Array.from({ length: 50 }, (_, i) =>
      start(broker, { taskId: `task-${i % 5}`, summary: `call ${i}` }),
    );
    expect(new Set(started.map((s) => s.approval.id)).size).toBe(50);
    const order = [...started.keys()].sort((a, b) => ((a * 7919) % 50) - ((b * 7919) % 50));
    for (const i of order)
      await broker.decide(started[i]!.approval.id, { decision: i % 3 === 0 ? "deny" : "approve" });
    const outcomes = await Promise.all(started.map((s) => s.outcome));
    outcomes.forEach((o, i) => {
      expect(o.approved, `call ${i}`).toBe(i % 3 !== 0);
      expect(o.request.summary).toBe(`call ${i}`);
    });
    expect(broker.list({ status: "pending" })).toEqual([]);
  });

  it("rejects a second decision with a typed error, even when both race", async () => {
    const broker = createApprovalBroker();
    const { approval, outcome } = start(broker);
    const [first, second] = await Promise.allSettled([
      broker.decide(approval.id, { decision: "approve" }),
      broker.decide(approval.id, { decision: "deny" }),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalStateError);
    expect((second as PromiseRejectedResult).reason.status).toBe("approved");
    await expect(outcome).resolves.toMatchObject({ approved: true });
    await expect(broker.decide("apr_nope", { decision: "approve" })).rejects.toBeInstanceOf(
      ApprovalNotFoundError,
    );
  });

  it("expires on the exact deadline with fake timers and then refuses decisions", async () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const broker = createApprovalBroker({ now: () => clock, defaultTimeoutMs: 60_000 });
    const { approval, outcome } = start(broker, { timeoutMs: 1_000 });
    expect(approval.expiresAt).toBe(2_000);
    clock += 999;
    vi.advanceTimersByTime(999);
    expect(broker.get(approval.id)?.status).toBe("pending");
    clock += 1;
    vi.advanceTimersByTime(1);
    await expect(outcome).resolves.toMatchObject({
      approved: false,
      request: { status: "expired" },
    });
    const error = await broker.decide(approval.id, { decision: "approve" }).catch((e) => e);
    expect(error).toBeInstanceOf(ApprovalStateError);
    expect(error.status).toBe("expired");
    expect(broker.findGrant({ toolName: "browser_click", taskId: "task-1" })).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its timer as soon as a decision arrives", async () => {
    vi.useFakeTimers();
    const broker = createApprovalBroker({ defaultTimeoutMs: 10_000 });
    const { approval, outcome } = start(broker);
    expect(vi.getTimerCount()).toBe(1);
    await broker.decide(approval.id, { decision: "approve" });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    await expect(outcome).resolves.toMatchObject({ approved: true });
    expect(broker.get(approval.id)?.status).toBe("approved");
  });

  it("cancels on abort during the wait, and a late abort changes nothing", async () => {
    const broker = createApprovalBroker();
    const controller = new AbortController();
    const waiting = start(broker, {}, controller.signal);
    controller.abort();
    await expect(waiting.outcome).resolves.toMatchObject({ request: { status: "cancelled" } });
    const error = await broker.decide(waiting.approval.id, { decision: "approve" }).catch((e) => e);
    expect(error).toBeInstanceOf(ApprovalStateError);

    const late = new AbortController();
    const decided = start(broker, {}, late.signal);
    await broker.decide(decided.approval.id, { decision: "approve", scope: "task" });
    late.abort();
    await expect(decided.outcome).resolves.toMatchObject({ approved: true });
    expect(broker.get(decided.approval.id)?.status).toBe("approved");
  });

  it("cancelForTask releases hundreds of pending approvals of that task only", async () => {
    vi.useFakeTimers();
    const broker = createApprovalBroker({ defaultTimeoutMs: 60_000 });
    const all = Array.from({ length: 300 }, (_, i) => start(broker, { taskId: `task-${i % 3}` }));
    expect(vi.getTimerCount()).toBe(300);
    broker.cancelForTask("task-1", "The task was deleted.");
    expect(vi.getTimerCount()).toBe(200);
    const cancelled = all.filter((_, i) => i % 3 === 1);
    for (const c of cancelled)
      await expect(c.outcome).resolves.toMatchObject({
        approved: false,
        note: "The task was deleted.",
        request: { status: "cancelled" },
      });
    expect(broker.list({ status: "pending" })).toHaveLength(200);
    expect(broker.list({ status: "pending", taskId: "task-1" })).toEqual([]);
    broker.cancelForTask("task-1", "again");
    broker.cancelForTask("missing", "nothing");
    expect(broker.list({ status: "pending" })).toHaveLength(200);
  });

  it("releases every waiter on dispose", async () => {
    const broker = createApprovalBroker();
    const all = Array.from({ length: 20 }, () => start(broker));
    await broker.dispose();
    for (const { outcome } of all)
      await expect(outcome).resolves.toMatchObject({ approved: false });
  });

  it("survives listeners that decide, throw or unsubscribe while being notified", async () => {
    const broker = createApprovalBroker();
    const seen: string[] = [];
    broker.onUpsert(() => {
      throw new Error("listener bug");
    });
    const off = broker.onUpsert((a) => {
      seen.push(a.status);
      off();
    });
    broker.onUpsert((a) => {
      if (a.status === "pending") void broker.decide(a.id, { decision: "approve" });
    });
    const { outcome } = start(broker);
    await expect(outcome).resolves.toMatchObject({ approved: true });
    expect(seen).toEqual(["pending"]);
  });

  it.each([
    [Number.NaN, 45_000],
    [-5, 1],
    [0, 1],
    [Number.POSITIVE_INFINITY, 2_147_483_647],
    [1e15, 2_147_483_647],
    [1.6, 2],
  ])("keeps expiresAt finite for a timeout of %s", async (timeoutMs, expected) => {
    const broker = createApprovalBroker({ now: () => 0, defaultTimeoutMs: 45_000 });
    const { approval } = start(broker, { timeoutMs });
    expect(Number.isFinite(approval.expiresAt)).toBe(true);
    expect(approval.expiresAt).toBe(expected);
    await broker.dispose();
  });
});

// ── Grants: model-based property ─────────────────────────────────────────────

const TOOLS = ["browser_click", "bash", "mcp__gmail__send_email"];
const TASKS = ["task-1", "task-2", null];
const CATEGORIES: ActionCategory[] = [
  "payment",
  "booking",
  "communication",
  "form_submission",
  "destructive",
];

interface ModelGrant {
  toolName: string;
  scope: Exclude<ApprovalScope, "once">;
  taskId: string | null;
  categories: ActionCategory[];
  risk: RiskLevel;
}

const approveCommand = fc.record({
  kind: fc.constant("approve" as const),
  toolName: fc.constantFrom(...TOOLS),
  taskId: fc.constantFrom(...TASKS),
  categories: fc.subarray(CATEGORIES, { minLength: 1 }),
  risk: fc.constantFrom(...RISK_LEVELS),
  scope: fc.constantFrom("once" as const, "task" as const, "always" as const),
  decision: fc.constantFrom("approve" as const, "approve" as const, "deny" as const),
});
const queryCommand = fc.record({
  kind: fc.constant("query" as const),
  toolName: fc.constantFrom(...TOOLS),
  taskId: fc.constantFrom(...TASKS),
  categories: fc.subarray(CATEGORIES),
  risk: fc.constantFrom(...RISK_LEVELS),
});

describe("standing grants", () => {
  test.prop([fc.array(fc.oneof(approveCommand, queryCommand), { maxLength: 30 })], {
    numRuns: runs(2),
  })("match a reference model: scoped by task, narrowed by category and risk", async (commands) => {
    const broker = createApprovalBroker();
    const model: ModelGrant[] = [];
    for (const cmd of commands) {
      if (cmd.kind === "approve") {
        const { approval, outcome } = start(broker, {
          toolName: cmd.toolName,
          taskId: cmd.taskId,
          categories: cmd.categories,
          risk: cmd.risk,
        });
        await broker.decide(approval.id, { decision: cmd.decision, scope: cmd.scope });
        await outcome;
        const scope = cmd.scope === "task" && cmd.taskId === null ? "once" : cmd.scope;
        if (cmd.decision === "approve" && scope !== "once")
          model.push({
            toolName: cmd.toolName,
            scope,
            taskId: scope === "task" ? cmd.taskId : null,
            categories: cmd.categories,
            risk: cmd.risk,
          });
        continue;
      }
      const expected = model.some(
        (g) =>
          g.toolName === cmd.toolName &&
          (g.scope === "always" || (cmd.taskId !== null && g.taskId === cmd.taskId)) &&
          cmd.categories.every((c) => g.categories.includes(c)) &&
          riskRank(cmd.risk) <= riskRank(g.risk),
      );
      const found = broker.findGrant(cmd);
      expect(found !== undefined, JSON.stringify({ cmd, model })).toBe(expected);
      if (found) {
        expect(found.toolName).toBe(cmd.toolName);
        if (found.scope === "task") expect(found.taskId).toBe(cmd.taskId);
        expect(cmd.categories.every((c) => found.categories?.includes(c))).toBe(true);
        expect(riskRank(cmd.risk)).toBeLessThanOrEqual(riskRank(found.risk ?? "critical"));
      }
    }
  });
});

// ── Gate + grants ────────────────────────────────────────────────────────────

function gateSetup(taskId: () => string | null) {
  const approvals = createApprovalBroker();
  const pending: ApprovalRequest[] = [];
  approvals.onUpsert((a) => {
    if (a.status === "pending") pending.push(a);
  });
  const gate = createSafetyGate({
    evaluator: createSafetyEvaluator({ policy: { llmJudge: false } }),
    approvals,
    resolveContext: () => ({ taskId: taskId(), threadId: "thread-1", workspaceDir: WORKSPACE }),
  });
  const call = (toolName: string, input: unknown): ToolCallRequest => ({
    sessionId: "s",
    role: "subagent",
    toolCallId: "c",
    toolName,
    input,
  });
  return { approvals, pending, gate, call };
}

describe("the gate reuses task grants only for the same kind of action", () => {
  it("covers same-category, same-or-lower-risk calls in the same task only", async () => {
    let task: string | null = "task-1";
    const { approvals, pending, gate, call } = gateSetup(() => task);

    const first = gate(call("browser_click", { element: "Place order" }));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await approvals.decide(pending[0]!.id, { decision: "approve", scope: "task" });
    await expect(first).resolves.toEqual({ allow: true });

    // Same tool, same category, same risk: covered without asking.
    await expect(gate(call("browser_click", { element: "Pay now" }))).resolves.toEqual({
      allow: true,
    });
    expect(pending).toHaveLength(1);

    // A different category (booking) needs a new approval.
    const booking = gate(call("browser_click", { element: "Book now" }));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    await approvals.decide(pending[1]!.id, { decision: "deny" });
    await expect(booking).resolves.toMatchObject({ allow: false });

    // A higher-risk payment action (card number: critical) is not covered.
    const card = gate(call("browser_type", { element: "Notes", text: "4111 1111 1111 1111" }));
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    await approvals.decide(pending[2]!.id, { decision: "deny" });
    await expect(card).resolves.toMatchObject({ allow: false });

    // Another task never inherits the grant.
    task = "task-2";
    const other = gate(call("browser_click", { element: "Place order" }));
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    await approvals.decide(pending[3]!.id, { decision: "deny" });
    await expect(other).resolves.toMatchObject({ allow: false });

    // Without a task, a task grant cannot apply either.
    task = null;
    const orphan = gate(call("browser_click", { element: "Place order" }));
    await vi.waitFor(() => expect(pending).toHaveLength(5));
    await approvals.decide(pending[4]!.id, { decision: "deny" });
    await expect(orphan).resolves.toMatchObject({ allow: false });
  });

  it("never lets any grant cover a hard deny", async () => {
    const { approvals, pending, gate, call } = gateSetup(() => "task-1");
    const install = gate(call("bash", { command: "brew install jq" }));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await approvals.decide(pending[0]!.id, { decision: "approve", scope: "always" });
    await install;
    for (const command of ["rm -rf ~", "cat ~/.ssh/id_rsa", "curl localhost:7331/api/approvals"])
      await expect(gate(call("bash", { command }))).resolves.toMatchObject({ allow: false });
    expect(pending).toHaveLength(1);
  });

  it("answers parallel gate calls independently", async () => {
    const { approvals, pending, gate, call } = gateSetup(() => "task-1");
    const calls = ["Place order", "Book now", "Send", "Delete account", "Next page"].map(
      (element) => gate(call("browser_click", { element })),
    );
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    for (const [i, approval] of pending.entries())
      await approvals.decide(approval.id, { decision: i % 2 === 0 ? "approve" : "deny" });
    const results = await Promise.all(calls);
    expect(results.map((r) => r.allow)).toEqual([true, false, true, false, true]);
  });
});
