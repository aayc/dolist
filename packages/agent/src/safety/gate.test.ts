import type { ApprovalRequest, ToolSpec } from "@ddl/core";
import { textResult } from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { ToolCallRequest } from "../harness/types";
import { createApprovalBroker, type PersistentApprovalBroker } from "./approvals";
import { createSafetyEvaluator } from "./evaluator";
import { createSafetyGate } from "./gate";
import { HIDDEN_VALUE } from "./sensitive";
import { WORKSPACE } from "./test-helpers";
import type {
  ActionContext,
  AllowedCall,
  SafetyEvaluator,
  SafetyGateOptions,
  SafetyVerdict,
} from "./types";

function setup(overrides: Partial<SafetyGateOptions> = {}) {
  const approvals = createApprovalBroker();
  const verdicts: SafetyVerdict[] = [];
  const gate = createSafetyGate({
    evaluator: createSafetyEvaluator({ policy: { llmJudge: false } }),
    approvals,
    resolveContext: () => ({
      taskId: "task-1",
      threadId: "thread-1",
      taskText: "Buy printer paper",
      workspaceDir: WORKSPACE,
    }),
    onVerdict: (_call, verdict) => verdicts.push(verdict),
    ...overrides,
  });
  return { gate, approvals, verdicts };
}

function call(
  toolName: string,
  input: unknown,
  extra: Partial<ToolCallRequest> = {},
): ToolCallRequest {
  return {
    sessionId: "session-1",
    role: "subagent",
    toolCallId: "call-1",
    toolName,
    input,
    ...extra,
  };
}

function nextPending(approvals: PersistentApprovalBroker): Promise<ApprovalRequest> {
  return new Promise((resolve) => {
    const off = approvals.onUpsert((a) => {
      if (a.status !== "pending") return;
      off();
      resolve(a);
    });
  });
}

describe("createSafetyGate", () => {
  it("allows benign calls without asking", async () => {
    const { gate, approvals, verdicts } = setup();
    await expect(gate(call("read", { path: "notes.md" }))).resolves.toEqual({ allow: true });
    expect(approvals.list()).toEqual([]);
    expect(verdicts.map((v) => v.decision)).toEqual(["allow"]);
  });

  it("blocks hard-denied calls with the reason and never asks", async () => {
    const { gate, approvals, verdicts } = setup();
    const decision = await gate(call("bash", { command: "rm -rf ~" }));
    expect(decision).toMatchObject({ allow: false });
    expect(decision.allow === false && decision.reason).toMatch(/home directory/);
    expect(approvals.list()).toEqual([]);
    expect(verdicts[0]?.decision).toBe("deny");
  });

  it("asks for approval and proceeds when the user approves", async () => {
    const { gate, approvals, verdicts } = setup();
    const pending = nextPending(approvals);
    const decision = gate(call("browser_click", { element: "Place order", ref: "e7" }));
    const approval = await pending;
    expect(approval).toMatchObject({
      threadId: "thread-1",
      taskId: "task-1",
      toolName: "browser_click",
      summary: "Click “Place order” in the browser",
      categories: ["payment"],
      status: "pending",
    });
    expect(approval.reason).toMatch(/purchase/);
    await approvals.decide(approval.id, { decision: "approve" });
    await expect(decision).resolves.toEqual({ allow: true });
    expect(verdicts.map((v) => v.decision)).toEqual(["require_approval"]);
  });

  it("reports denials, expiry and cancellation to the agent", async () => {
    const denied = setup();
    const pending = nextPending(denied.approvals);
    const result = denied.gate(call("browser_click", { element: "Book now" }));
    await denied.approvals.decide((await pending).id, { decision: "deny", note: "wrong date" });
    await expect(result).resolves.toEqual({ allow: false, reason: "User denied: wrong date" });

    const expired = setup({ approvalTimeoutMs: 10 });
    await expect(expired.gate(call("browser_click", { element: "Send" }))).resolves.toEqual({
      allow: false,
      reason: "Approval expired",
    });

    const cancelled = setup();
    const waiting = nextPending(cancelled.approvals);
    const pendingCall = cancelled.gate(call("browser_click", { element: "Send" }));
    await waiting;
    cancelled.approvals.cancelForTask("task-1", "Task deleted");
    await expect(pendingCall).resolves.toEqual({
      allow: false,
      reason: "Approval cancelled: Task deleted",
    });
  });

  it("honors task grants for the same kind of action only", async () => {
    const { gate, approvals, verdicts } = setup();
    const first = nextPending(approvals);
    const firstCall = gate(call("browser_click", { element: "Place order" }));
    await approvals.decide((await first).id, { decision: "approve", scope: "task" });
    await firstCall;

    await expect(gate(call("browser_click", { element: "Pay now" }))).resolves.toEqual({
      allow: true,
    });
    expect(verdicts.at(-1)).toMatchObject({ decision: "allow", source: "grant" });
    expect(approvals.list()).toHaveLength(1);

    const other = nextPending(approvals);
    const deleteCall = gate(call("browser_click", { element: "Delete my account" }));
    const second = await other;
    expect(second.categories).toContain("account");
    await approvals.decide(second.id, { decision: "deny" });
    await expect(deleteCall).resolves.toMatchObject({ allow: false });
  });

  it("never lets a task grant for plain desktop typing send a message with a line break", async () => {
    const { gate, approvals, verdicts } = setup({
      resolveContext: () => ({
        taskId: "task-1",
        threadId: "thread-1",
        taskText: "Send myself a Slack message: buy milk",
        workspaceDir: WORKSPACE,
      }),
    });
    const first = nextPending(approvals);
    const typing = gate(call("computer_type", { text: "buy milk" }));
    await approvals.decide((await first).id, { decision: "approve", scope: "task" });
    await expect(typing).resolves.toEqual({ allow: true });
    await expect(gate(call("computer_type", { text: "and eggs" }))).resolves.toEqual({
      allow: true,
    });
    expect(verdicts.at(-1)).toMatchObject({ source: "grant" });

    const next = nextPending(approvals);
    const sending = gate(call("computer_type", { text: "buy milk\n" }));
    const approval = await Promise.race([next, sending.then(() => undefined)]);
    if (!approval) throw new Error("Typing that presses Return ran without asking");
    expect(approval.categories).toContain("form_submission");
    expect(approval.summary).toBe("Type “buy milk” on the computer (presses Return)");
    await approvals.decide(approval.id, { decision: "deny" });
    await expect(sending).resolves.toMatchObject({ allow: false });
  });

  it("never lets a grant override a hard deny", async () => {
    const { gate, approvals } = setup();
    const pending = nextPending(approvals);
    const install = gate(call("bash", { command: "brew install jq" }));
    await approvals.decide((await pending).id, { decision: "approve", scope: "always" });
    await install;
    await expect(gate(call("bash", { command: "rm -rf /" }))).resolves.toMatchObject({
      allow: false,
    });
  });

  it("builds the action context from the spec, built-in hints and session context", async () => {
    const seen: ActionContext[] = [];
    const inner = createSafetyEvaluator({ policy: { llmJudge: false } });
    const evaluator: SafetyEvaluator = {
      evaluate: (ctx) => {
        seen.push(ctx);
        return inner.evaluate(ctx);
      },
    };
    const spec: ToolSpec = {
      name: "lookup",
      label: "Lookup",
      description: "Looks things up",
      parameters: { type: "object" },
      safety: { readOnly: true, category: "read" },
      execute: async () => textResult("ok"),
    };
    const { gate } = setup({ evaluator, approvalTimeoutMs: 10 });
    await gate(call("lookup", { q: "x" }, { spec }));
    await gate(call("bash", { command: "ls" }));
    await expect(gate(call("mystery", {}))).resolves.toEqual({
      allow: false,
      reason: "Approval expired",
    });
    expect(seen[0]).toMatchObject({
      toolLabel: "Lookup",
      hints: spec.safety,
      taskId: "task-1",
      taskText: "Buy printer paper",
      workspaceDir: WORKSPACE,
    });
    expect(seen[1]?.hints).toEqual({ category: "system" });
    expect(seen[2]?.hints).toEqual({});
  });

  it("hides typed secrets on the approval card", async () => {
    const { gate, approvals } = setup();
    const pending = nextPending(approvals);
    const result = gate(call("browser_type", { element: "Password", text: "hunter22" }));
    const approval = await pending;
    expect(approval.input).toEqual({ element: "Password", text: HIDDEN_VALUE });
    expect(approval.summary).toBe("Type into “Password” (value hidden) in the browser");
    await approvals.decide(approval.id, { decision: "deny" });
    await result;
  });

  it("fails closed when anything inside it breaks", async () => {
    const broken = setup({
      resolveContext: () => {
        throw new Error("unknown session");
      },
    });
    await expect(broken.gate(call("read", { path: "a" }))).resolves.toMatchObject({
      allow: false,
      reason: expect.stringMatching(/safety check failed/),
    });

    const throwing = setup({
      evaluator: {
        evaluate: () => Promise.reject(new Error("boom")),
      },
    });
    await expect(throwing.gate(call("read", { path: "a" }))).resolves.toMatchObject({
      allow: false,
    });

    const noisy = setup({
      onVerdict: () => {
        throw new Error("listener bug");
      },
    });
    await expect(noisy.gate(call("read", { path: "a" }))).resolves.toEqual({ allow: true });
  });
});

describe("onAllowed (the journal's write-ahead record)", () => {
  function recording(overrides: Partial<SafetyGateOptions> = {}) {
    const allowed: Array<{ call: string; allowed: AllowedCall }> = [];
    const s = setup({
      onAllowed: (c, a) => allowed.push({ call: c.toolCallId, allowed: a }),
      ...overrides,
    });
    return { ...s, allowed };
  }

  it("says how each call was let through and what it does, and never for a blocked one", async () => {
    const s = recording();
    await s.gate(call("read", { path: "notes.md" }, { toolCallId: "c-read" }));
    await s.gate(call("bash", { command: "rm -rf ~" }, { toolCallId: "c-deny" }));
    const pending = nextPending(s.approvals);
    const approved = s.gate(
      call("browser_click", { element: "Place order", ref: "e7" }, { toolCallId: "c-buy" }),
    );
    const approval = await pending;
    await s.approvals.decide(approval.id, { decision: "approve", scope: "task" });
    await approved;
    await s.gate(
      call("browser_click", { element: "Place order", ref: "e7" }, { toolCallId: "c-again" }),
    );
    expect(s.allowed).toEqual([
      {
        call: "c-read",
        allowed: expect.objectContaining({ via: "evaluator", effectful: false }),
      },
      {
        call: "c-buy",
        allowed: {
          summary: "Click “Place order” in the browser",
          via: "approval",
          approvalId: approval.id,
          effectful: true,
        },
      },
      {
        call: "c-again",
        allowed: expect.objectContaining({ via: "grant", effectful: true }),
      },
    ]);
  });

  it("reports calls the approval policy lets through, and survives a broken listener", async () => {
    const s = recording({ approvalPolicy: () => "run_everything" });
    await expect(
      s.gate(call("browser_click", { element: "Place order" }, { toolCallId: "c-1" })),
    ).resolves.toEqual({ allow: true });
    expect(s.allowed[0]?.allowed).toMatchObject({ via: "policy", effectful: true });

    const broken = setup({
      onAllowed: () => {
        throw new Error("listener bug");
      },
    });
    await expect(broken.gate(call("read", { path: "a" }))).resolves.toEqual({ allow: true });
  });
});
