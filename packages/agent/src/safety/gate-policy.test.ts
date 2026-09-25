/**
 * The approval policy in the gate: every policy × evaluator decision × effectful or not × standing
 * grant or not, what is reported for each, the policy read on every call, and the real evaluator's
 * verdicts under each policy (hard denies hold under all of them).
 */
import {
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  type ApprovalRequest,
  type RiskLevel,
  type SafetyDecision,
} from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { ToolCallDecision, ToolCallRequest } from "../harness/types";
import { TOOL } from "../tools/contracts";
import { EVERY_ACTION_REASON, POLICY_ALLOW_REASONS } from "./approval-policy";
import { createApprovalBroker, type PersistentApprovalBroker } from "./approvals";
import { createSafetyEvaluator } from "./evaluator";
import { createSafetyGate } from "./gate";
import { WORKSPACE } from "./test-helpers";
import type { SafetyEvaluator, SafetyGateOptions, SafetyVerdict } from "./types";

const EVALUATOR_REASON = "What the evaluator found.";

function scripted(verdict: Partial<SafetyVerdict>): SafetyEvaluator {
  return {
    evaluate: async () => ({
      decision: "allow",
      risk: "low",
      categories: ["payment"],
      reason: EVALUATOR_REASON,
      summary: "Do the thing",
      source: "rules",
      latencyMs: 0,
      ...verdict,
    }),
  };
}

function call(toolName = "tool", input: unknown = {}): ToolCallRequest {
  return { sessionId: "session-1", role: "subagent", toolCallId: "call-1", toolName, input };
}

type Outcome =
  | { kind: "ran"; decision: ToolCallDecision; reported: SafetyVerdict[] }
  | { kind: "asked"; approval: ApprovalRequest; reported: SafetyVerdict[] };

/** A grant for the task that covers the scripted verdicts (same tool and categories, any risk). */
async function grantFor(approvals: PersistentApprovalBroker): Promise<void> {
  const outcome = approvals.request({
    threadId: "thread-1",
    taskId: "task-1",
    toolName: "tool",
    input: {},
    summary: "Earlier action",
    risk: "critical",
    categories: ["payment"],
    reason: "asked earlier",
  });
  await approvals.decide(approvals.list({ status: "pending" })[0]!.id, {
    decision: "approve",
    scope: "task",
  });
  await outcome;
}

async function run(
  policy: ApprovalPolicy | (() => ApprovalPolicy),
  verdict: Partial<SafetyVerdict>,
  { grant = false, ...options }: { grant?: boolean } & Partial<SafetyGateOptions> = {},
): Promise<Outcome & { approvals: PersistentApprovalBroker }> {
  const approvals = createApprovalBroker();
  if (grant) await grantFor(approvals);
  const reported: SafetyVerdict[] = [];
  const gate = createSafetyGate({
    evaluator: scripted(verdict),
    approvals,
    resolveContext: () => ({ taskId: "task-1", threadId: "thread-1", workspaceDir: WORKSPACE }),
    approvalPolicy: typeof policy === "function" ? policy : () => policy,
    onVerdict: (_call, v) => reported.push(v),
    ...options,
  });
  const asked = new Promise<ApprovalRequest>((resolve) => {
    approvals.onUpsert((a) => {
      if (a.status === "pending") resolve(a);
    });
  });
  const decision = gate(call());
  const first = await Promise.race([
    decision.then((d) => ({ kind: "ran" as const, decision: d })),
    asked.then((a) => ({ kind: "asked" as const, approval: a })),
  ]);
  if (first.kind === "asked") {
    await approvals.decide(first.approval.id, { decision: "deny" });
    await decision;
  }
  return { ...first, reported, approvals };
}

interface Case {
  policy: ApprovalPolicy;
  decision: SafetyDecision;
  effectful: boolean;
  risk: RiskLevel;
  grant: boolean;
}

/** What each policy should do, written out independently of the implementation. */
function expected(c: Case): "deny" | "allow" | "policy-allow" | "grant" | "ask" {
  if (c.decision === "deny") return "deny";
  const risky = c.risk === "high" || c.risk === "critical";
  const asks =
    c.policy === "run_everything"
      ? false
      : c.policy === "ask_high_risk"
        ? c.decision === "require_approval" && risky
        : c.policy === "ask_risky"
          ? c.decision === "require_approval"
          : c.decision === "require_approval" || c.effectful;
  if (!asks) return c.decision === "allow" ? "allow" : "policy-allow";
  return c.grant ? "grant" : "ask";
}

const CASES: Case[] = APPROVAL_POLICIES.flatMap((policy) =>
  (["allow", "require_approval", "deny"] as const).flatMap((decision) =>
    [true, false].flatMap((effectful) =>
      (["medium", "high"] as const).flatMap((risk) =>
        [true, false].map((grant) => ({ policy, decision, effectful, risk, grant })),
      ),
    ),
  ),
);

describe("the approval policy in the gate", () => {
  it.each(
    CASES.map((c) => [
      `${c.policy} · ${c.decision} · ${c.effectful ? "effectful" : "read-only"} · ${c.risk} · ${c.grant ? "grant" : "no grant"}`,
      c,
    ]),
  )("%s", async (_name, c) => {
    const verdict: Partial<SafetyVerdict> = {
      decision: c.decision,
      risk: c.risk,
      effectful: c.effectful,
    };
    const outcome = await run(c.policy, verdict, { grant: c.grant });
    const want = expected(c);
    expect(outcome.reported).toHaveLength(1);
    const reported = outcome.reported[0]!;
    switch (want) {
      case "deny":
        expect(outcome).toMatchObject({ kind: "ran", decision: { allow: false } });
        expect(reported).toMatchObject({ decision: "deny", reason: EVALUATOR_REASON });
        break;
      case "allow":
        expect(outcome).toMatchObject({ kind: "ran", decision: { allow: true } });
        expect(reported).toMatchObject({ decision: "allow", source: "rules" });
        expect(reported.reason).toBe(EVALUATOR_REASON);
        break;
      case "policy-allow":
        expect(outcome).toMatchObject({ kind: "ran", decision: { allow: true } });
        expect(reported).toMatchObject({
          decision: "allow",
          source: "policy",
          reason: POLICY_ALLOW_REASONS[c.policy],
          risk: c.risk,
          categories: ["payment"],
          summary: "Do the thing",
        });
        break;
      case "grant":
        expect(outcome).toMatchObject({ kind: "ran", decision: { allow: true } });
        expect(reported).toMatchObject({ decision: "allow", source: "grant" });
        break;
      case "ask": {
        if (outcome.kind !== "asked") throw new Error(`expected an approval, got ${outcome.kind}`);
        const onlyPolicy = c.decision === "allow";
        expect(outcome.approval).toMatchObject({
          summary: "Do the thing",
          risk: c.risk,
          categories: ["payment"],
          reason: onlyPolicy ? EVERY_ACTION_REASON : EVALUATOR_REASON,
        });
        expect(reported).toMatchObject({
          decision: "require_approval",
          source: onlyPolicy ? "policy" : "rules",
        });
        break;
      }
    }
    // Nothing ever asks for a denied action, and nothing else is left waiting.
    expect(outcome.approvals.list({ status: "pending" })).toEqual([]);
  });

  it("reports the exact reasons of the policies that let actions run", () => {
    expect(POLICY_ALLOW_REASONS).toEqual({
      run_everything: "Your approval policy runs everything without asking.",
      ask_high_risk: "Your approval policy only asks for high-risk actions.",
    });
    expect(EVERY_ACTION_REASON).toBe("Your approval policy asks before every action.");
  });

  it("reads the policy on every call, so a change applies to the next one", async () => {
    let policy: ApprovalPolicy = "ask_risky";
    const approvals = createApprovalBroker();
    const gate = createSafetyGate({
      evaluator: scripted({ decision: "require_approval", risk: "high" }),
      approvals,
      resolveContext: () => ({ taskId: "task-1", threadId: "thread-1" }),
      approvalPolicy: () => policy,
      approvalTimeoutMs: 10,
    });
    await expect(gate(call())).resolves.toEqual({ allow: false, reason: "Approval expired" });
    policy = "run_everything";
    await expect(gate(call())).resolves.toEqual({ allow: true });
    policy = "ask_high_risk";
    await expect(gate(call())).resolves.toEqual({ allow: false, reason: "Approval expired" });
    policy = "run_everything";
    await expect(gate(call())).resolves.toEqual({ allow: true });
    expect(approvals.list().map((a) => a.status)).toEqual(["expired", "expired"]);
  });

  it("reads the policy after the evaluation, when it decides", async () => {
    let policy: ApprovalPolicy = "ask_risky";
    let release!: () => void;
    const slow: SafetyEvaluator = {
      evaluate: async (ctx) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return scripted({ decision: "require_approval", risk: "high" }).evaluate(ctx);
      },
    };
    const gate = createSafetyGate({
      evaluator: slow,
      approvals: createApprovalBroker(),
      resolveContext: () => ({ taskId: "task-1", threadId: "thread-1" }),
      approvalPolicy: () => policy,
    });
    const decision = gate(call());
    await Promise.resolve();
    policy = "run_everything";
    release();
    await expect(decision).resolves.toEqual({ allow: true });
  });

  it("treats a value that isn't a policy as the default, never as looser", async () => {
    const odd = () => "never_ask" as ApprovalPolicy;
    const risky = await run(odd, { decision: "require_approval", risk: "medium" });
    expect(risky.kind).toBe("asked");
    const benign = await run(odd, { decision: "allow", effectful: true });
    expect(benign.kind).toBe("ran");
    const missing = await run(() => undefined as unknown as ApprovalPolicy, {
      decision: "require_approval",
    });
    expect(missing.kind).toBe("asked");
  });

  it("asks for the default when no policy is wired", async () => {
    const approvals = createApprovalBroker();
    const gate = createSafetyGate({
      evaluator: scripted({ decision: "require_approval", risk: "medium" }),
      approvals,
      resolveContext: () => ({ taskId: "task-1", threadId: "thread-1" }),
      approvalTimeoutMs: 10,
    });
    await expect(gate(call())).resolves.toEqual({ allow: false, reason: "Approval expired" });
  });

  it("fails closed when reading the policy throws", async () => {
    const outcome = await run(
      () => {
        throw new Error("settings unavailable");
      },
      { decision: "allow", effectful: false },
    );
    expect(outcome).toMatchObject({
      kind: "ran",
      decision: { allow: false, reason: "The safety check failed, so this action was blocked." },
    });
  });

  it("counts a verdict that doesn't say whether it is effectful as effectful", async () => {
    const outcome = await run("ask_every_action", { decision: "allow" });
    expect(outcome.kind).toBe("asked");
  });

  it("never reads the policy for a denial", async () => {
    let reads = 0;
    const outcome = await run(
      () => {
        reads++;
        return "run_everything";
      },
      { decision: "deny", risk: "critical" },
    );
    expect(outcome).toMatchObject({ kind: "ran", decision: { allow: false } });
    expect(reads).toBe(0);
  });

  it("records why each approval was asked, for a later, looser policy", async () => {
    const approvals = createApprovalBroker();
    let policy: ApprovalPolicy = "ask_every_action";
    const pending: Promise<ToolCallDecision>[] = [];
    for (const verdict of [
      { decision: "allow" as const, effectful: true },
      { decision: "require_approval" as const, risk: "medium" as const },
      { decision: "require_approval" as const, risk: "critical" as const },
    ]) {
      const gate = createSafetyGate({
        evaluator: scripted(verdict),
        approvals,
        resolveContext: () => ({ taskId: "task-1", threadId: "thread-1" }),
        approvalPolicy: () => policy,
      });
      pending.push(gate(call()));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(approvals.list({ status: "pending" })).toHaveLength(3);
    const seen: string[] = [];
    policy = "ask_risky";
    approvals.approvePending(({ request, verdict }) => {
      seen.push(`${verdict}:${request.risk}`);
      return false;
    }, "unused");
    expect(seen).toEqual(["allow:low", "require_approval:medium", "require_approval:critical"]);
    for (const approval of approvals.list({ status: "pending" }))
      await approvals.decide(approval.id, { decision: "deny" });
    await Promise.all(pending);
  });
});

describe("the real evaluator under each policy", () => {
  function gateWith(policy: ApprovalPolicy) {
    const approvals = createApprovalBroker();
    const gate = createSafetyGate({
      evaluator: createSafetyEvaluator({ policy: { llmJudge: false } }),
      approvals,
      resolveContext: () => ({
        taskId: "task-1",
        threadId: "thread-1",
        taskText: "Buy printer paper and send the receipt",
        workspaceDir: WORKSPACE,
      }),
      approvalPolicy: () => policy,
      approvalTimeoutMs: 20,
    });
    return { gate, approvals };
  }

  /** Tools without a spec get their built-in hints or none, as harness built-ins do. */
  async function asks(policy: ApprovalPolicy, toolName: string, input: unknown) {
    const { gate, approvals } = gateWith(policy);
    const decision = await gate(call(toolName, input));
    if (decision.allow) return "runs";
    return approvals.list().length > 0 ? "asks" : "blocked";
  }

  const READS: Array<[string, unknown]> = [
    [TOOL.read, { path: `${WORKSPACE}/notes.txt` }],
    [TOOL.grep, { path: WORKSPACE, pattern: "paper" }],
    [TOOL.readNote, { path: "Daily/2026-09-24.md" }],
    [TOOL.searchNotes, { query: "printer" }],
    [TOOL.webSearch, { query: "printer paper prices" }],
    [TOOL.webFetch, { url: "https://example.com/paper" }],
    [TOOL.postUpdate, { text: "Found three shops" }],
    [TOOL.browserSnapshot, {}],
    [TOOL.browserScreenshot, {}],
    [TOOL.computerScreenshot, {}],
    [TOOL.computerApps, {}],
    [TOOL.computerAppState, { app: "Notes" }],
  ];

  const CHANGES: Array<[string, unknown]> = [
    [TOOL.write, { path: `${WORKSPACE}/list.md`, content: "- paper" }],
    [TOOL.editNote, { edits: [{ op: "append", text: "Found it", mine: true }] }],
    [TOOL.browserType, { element: "Search", text: "printer paper" }],
    [TOOL.bash, { command: "ls" }],
  ];

  it.each(READS)("%s never asks, under any policy", async (toolName, input) => {
    for (const policy of APPROVAL_POLICIES)
      expect(await asks(policy, toolName, input), policy).toBe("runs");
  });

  it.each(CHANGES)("%s asks only when asking before every action", async (toolName, input) => {
    expect(await asks("ask_every_action", toolName, input)).toBe("asks");
    for (const policy of ["ask_risky", "ask_high_risk", "run_everything"] as const)
      expect(await asks(policy, toolName, input), policy).toBe("runs");
  });

  it("asks for a purchase unless the policy runs everything", async () => {
    const order = [TOOL.browserClick, { element: "Place order" }] as const;
    expect(await asks("ask_every_action", ...order)).toBe("asks");
    expect(await asks("ask_risky", ...order)).toBe("asks");
    expect(await asks("ask_high_risk", ...order)).toBe("asks");
    expect(await asks("run_everything", ...order)).toBe("runs");
  });

  it("lets a medium-risk action run when only high-risk actions ask", async () => {
    const submit = [TOOL.browserClick, { element: "Submit" }] as const;
    expect(await asks("ask_risky", ...submit)).toBe("asks");
    expect(await asks("ask_high_risk", ...submit)).toBe("runs");
  });

  it.each([
    [TOOL.bash, { command: "rm -rf ~" }],
    [TOOL.bash, { command: "cat ~/.ssh/id_ed25519" }],
    [TOOL.bash, { command: "security dump-keychain -d" }],
    [TOOL.browserNavigate, { url: "http://127.0.0.1:7331/" }],
    [TOOL.computerPress, { app: "1Password", id: "e1" }],
    [TOOL.computerSetValue, { app: "System Settings", id: "e2", value: "x" }],
    [TOOL.write, { path: "/Users/me/DailyDoList/.daily-do-list/settings.json", content: "{}" }],
  ])("hard denies hold under every policy: %s %j", async (toolName, input) => {
    for (const policy of APPROVAL_POLICIES)
      expect(await asks(policy, toolName, input), policy).toBe("blocked");
  });
});
