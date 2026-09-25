/**
 * The orchestrator's routine tools through the real (rules-only) evaluator and gate under every
 * approval policy: what asks, what runs, what the approval card says, and that a tool runs only
 * once the gate allows it.
 */
import {
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ToolSpec,
} from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { ToolCallDecision } from "../harness/types";
import { createApprovalBroker } from "../safety/approvals";
import { createSafetyEvaluator } from "../safety/evaluator";
import { createSafetyGate } from "../safety/gate";
import { TOOL } from "../tools/contracts";
import { createRoutineTools, type RoutineToolHost } from "../tools/routines";

class RecordingHost implements RoutineToolHost {
  readonly calls: Array<{ method: string; input?: unknown }> = [];

  async createRoutine(input: unknown): Promise<string> {
    this.calls.push({ method: "createRoutine", input });
    return "Created.";
  }

  async updateRoutine(input: unknown): Promise<string> {
    this.calls.push({ method: "updateRoutine", input });
    return "Updated.";
  }

  async runRoutine(input: unknown): Promise<string> {
    this.calls.push({ method: "runRoutine", input });
    return "Started.";
  }

  async listRoutines(): Promise<string> {
    this.calls.push({ method: "listRoutines" });
    return "- “Morning briefing”: Every weekday at 7:30 AM";
  }
}

type Outcome = "asks" | "runs";

interface Case {
  name: string;
  tool: string;
  input: Record<string, unknown>;
  card: string;
  /** Per policy, in APPROVAL_POLICIES order: ask_every_action, ask_risky, ask_high_risk, run_everything. */
  expected: readonly [Outcome, Outcome, Outcome, Outcome];
}

const CASES: Case[] = [
  {
    name: "create a routine",
    tool: TOOL.createRoutine,
    input: {
      name: "Morning briefing",
      schedule: "every weekday at 7:30",
      instructions: "Brief me for the day: calendar and SF weather. Under 10 lines.",
      notify: "always",
      uses: ["web"],
    },
    card: "Create routine “Morning briefing”: every weekday at 7:30 (Every weekday at 7:30 AM) — Brief me for the day: calendar and SF weather. Under 10 lines.",
    expected: ["asks", "asks", "runs", "runs"],
  },
  {
    name: "change when a routine runs",
    tool: TOOL.updateRoutine,
    input: { name: "Morning briefing", schedule: "every day at 6:45" },
    card: "Change routine “Morning briefing”: every day at 6:45",
    expected: ["asks", "asks", "runs", "runs"],
  },
  {
    name: "change what a routine does",
    tool: TOOL.updateRoutine,
    input: {
      name: "Price watch",
      instructions: "Also check the red kettle.",
      notify: "when_changed",
    },
    card: "Change routine “Price watch”: new instructions “Also check the red kettle.”; notify when_changed",
    expected: ["asks", "asks", "runs", "runs"],
  },
  {
    name: "resume a routine",
    tool: TOOL.updateRoutine,
    input: { name: "Price watch", paused: false },
    card: "Resume routine “Price watch”",
    expected: ["asks", "asks", "runs", "runs"],
  },
  {
    name: "pause a routine",
    tool: TOOL.updateRoutine,
    input: { name: "Price watch", paused: true },
    card: "Pause routine “Price watch”",
    expected: ["asks", "runs", "runs", "runs"],
  },
  {
    name: "run a routine now",
    tool: TOOL.runRoutine,
    input: { name: "Morning briefing" },
    card: "Run routine “Morning briefing” now",
    expected: ["asks", "runs", "runs", "runs"],
  },
  {
    name: "list routines",
    tool: TOOL.listRoutines,
    input: {},
    card: "List routines",
    expected: ["runs", "runs", "runs", "runs"],
  },
];

/** Gates one call like the harness does: the tool executes only on `allow`. */
async function attempt(policy: ApprovalPolicy, tool: ToolSpec, input: unknown) {
  const approvals = createApprovalBroker();
  const gate = createSafetyGate({
    evaluator: createSafetyEvaluator({ policy: { llmJudge: false } }),
    approvals,
    resolveContext: () => ({ taskId: "task-1", threadId: "thread-1", taskText: "Brief me daily" }),
    approvalPolicy: () => policy,
  });
  const asked = new Promise<ApprovalRequest>((resolve) => {
    approvals.onUpsert((approval) => {
      if (approval.status === "pending") resolve(approval);
    });
  });
  const decision = gate({
    sessionId: "orchestrator:1",
    role: "orchestrator",
    toolCallId: "call-1",
    toolName: tool.name,
    input,
    spec: tool,
  }).then(async (d: ToolCallDecision) => {
    if (d.allow) await tool.execute(input, { toolCallId: "call-1" } as never);
    return d;
  });
  const first = await Promise.race([
    decision.then(() => ({ kind: "runs" as const })),
    asked.then((approval) => ({ kind: "asks" as const, approval })),
  ]);
  return { first, decision, approvals };
}

function toolsWith(host: RoutineToolHost): Map<string, ToolSpec> {
  return new Map(createRoutineTools(host).map((tool) => [tool.name, tool]));
}

describe("routine tools under each approval policy", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    for (const [i, policy] of APPROVAL_POLICIES.entries()) {
      const host = new RecordingHost();
      const tool = toolsWith(host).get(c.tool)!;
      const { first, decision, approvals } = await attempt(policy, tool, c.input);
      expect(first.kind, policy).toBe(c.expected[i]);
      if (first.kind === "asks") {
        expect(first.approval, policy).toMatchObject({ toolName: c.tool, summary: c.card });
        expect(host.calls, `${policy}: ran before approval`).toEqual([]);
        await approvals.decide(first.approval.id, { decision: "approve" });
      }
      await expect(decision, policy).resolves.toEqual({ allow: true });
      expect(host.calls, policy).toHaveLength(1);
    }
  });

  it("a denied approval never runs the tool", async () => {
    const host = new RecordingHost();
    const tool = toolsWith(host).get(TOOL.createRoutine)!;
    const { first, decision, approvals } = await attempt("ask_risky", tool, CASES[0]!.input);
    expect(first.kind).toBe("asks");
    if (first.kind === "asks") {
      await approvals.decide(first.approval.id, { decision: "deny", note: "Not now" });
    }
    await expect(decision).resolves.toMatchObject({ allow: false });
    expect(host.calls).toEqual([]);
  });

  it("lists the policies in the order the cases assume", () => {
    expect(APPROVAL_POLICIES).toEqual([
      "ask_every_action",
      "ask_risky",
      "ask_high_risk",
      "run_everything",
    ]);
  });
});

describe("routine tool input", () => {
  it("reports bad input to the model instead of calling the host", async () => {
    const host = new RecordingHost();
    const tools = toolsWith(host);
    const update = await tools
      .get(TOOL.updateRoutine)!
      .execute({ name: "Price watch" }, { toolCallId: "call-1" } as never);
    expect(update).toMatchObject({ isError: true });
    const create = await tools
      .get(TOOL.createRoutine)!
      .execute(
        { name: "Kettle", schedule: "every hour", instructions: "Check.", notify: "sometimes" },
        { toolCallId: "call-1" } as never,
      );
    expect(create).toMatchObject({ isError: true });
    expect(host.calls).toEqual([]);
  });

  it("declares honest hints: only listing is read-only", () => {
    const tools = toolsWith(new RecordingHost());
    expect(
      [...tools.values()].map((tool) => [
        tool.name,
        tool.safety.readOnly === true,
        tool.safety.category,
      ]),
    ).toEqual([
      [TOOL.createRoutine, false, "file_write"],
      [TOOL.updateRoutine, false, "file_write"],
      [TOOL.runRoutine, false, "compute"],
      [TOOL.listRoutines, true, "read"],
    ]);
  });
});
