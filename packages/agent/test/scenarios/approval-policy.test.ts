/**
 * Approval policies through the whole runtime (real evaluator, gate and broker): what each policy
 * asks about, a change applying to the very next tool call, and pending approvals when the policy
 * gets looser (approved) or stricter (left alone).
 */
import type { ApprovalPolicy } from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { FakeAgentRuntime } from "../../src/testing";
import { expectAllGated, fakeRuntime, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

function setPolicy(t: FakeAgentRuntime, approvalPolicy: ApprovalPolicy): void {
  t.runtime.updateSettings({ ...t.settings, agent: { ...t.settings.agent, approvalPolicy } });
}

const BOOKING = "Book a table for two on Friday";

function riskyVerdicts(t: FakeAgentRuntime) {
  return t.audit.gate
    .filter((g) => g.toolName === "mock_irreversible_action")
    .map((g) => g.verdict);
}

describe("approval policies", () => {
  it("runs the irreversible step without asking when the policy runs everything", async () => {
    const t = await fakeRuntime({ settings: { agent: { approvalPolicy: "run_everything" } } });
    await t.writeDailyNote([`- [ ] ${BOOKING}`]);
    const done = await t.waitForStatus(BOOKING, "done");
    expect(done.summary).toBe("Booked (mock)");
    expect(t.runtime.listApprovals()).toEqual([]);
    expect(riskyVerdicts(t)).toEqual([
      expect.objectContaining({
        decision: "allow",
        source: "policy",
        reason: "Your approval policy runs everything without asking.",
        categories: ["booking"],
      }),
    ]);
    expectAllGated(t);
  });

  it("runs a medium-risk step when only high-risk actions ask", async () => {
    const t = await fakeRuntime({ settings: { agent: { approvalPolicy: "ask_high_risk" } } });
    await t.writeDailyNote([`- [ ] ${BOOKING}`]);
    await t.waitForStatus(BOOKING, "done");
    expect(t.runtime.listApprovals()).toEqual([]);
    expect(riskyVerdicts(t)).toEqual([
      expect.objectContaining({
        decision: "allow",
        source: "policy",
        risk: "medium",
        reason: "Your approval policy only asks for high-risk actions.",
      }),
    ]);
  });

  it("applies a change to the very next tool call", async () => {
    const t = await fakeRuntime();
    setPolicy(t, "run_everything");
    await t.writeDailyNote([`- [ ] ${BOOKING}`]);
    await t.waitForStatus(BOOKING, "done");
    expect(t.runtime.listApprovals()).toEqual([]);

    setPolicy(t, "ask_risky");
    const next = "Book a haircut for Saturday";
    await t.writeDailyNote([`- [x] ${BOOKING}`, `- [ ] ${next}`]);
    await t.waitForStatus(next, "waiting_approval");
    expect(t.pendingApprovals()).toHaveLength(1);
    expectAllGated(t);
  });

  it("switching to Run everything approves what is waiting, and the work continues", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([`- [ ] ${BOOKING}`]);
    await t.waitForStatus(BOOKING, "waiting_approval");
    setPolicy(t, "run_everything");
    const done = await t.waitForStatus(BOOKING, "done");
    expect(done.summary).toBe("Booked (mock)");
    expect(t.runtime.listApprovals()).toEqual([
      expect.objectContaining({
        status: "approved",
        scope: "once",
        decisionNote: "Approved by your approval policy",
      }),
    ]);
    expect(t.runtime.status().pendingApprovals).toBe(0);
    expectAllGated(t);
  });

  it("a looser policy approves only what it wouldn't ask about", async () => {
    const t = await fakeRuntime({ settings: { agent: { approvalPolicy: "ask_every_action" } } });
    await t.writeDailyNote([`- [ ] ${BOOKING}`]);
    await t.waitForStatus(BOOKING, "waiting_approval");
    const [approval] = t.pendingApprovals();
    expect(approval).toMatchObject({ toolName: "mock_irreversible_action", risk: "medium" });
    // Asking for risky actions still asks about this one.
    setPolicy(t, "ask_risky");
    expect(t.pendingApprovals()).toHaveLength(1);
    // Only high-risk actions ask: a medium-risk one waiting is approved.
    setPolicy(t, "ask_high_risk");
    await t.waitForStatus(BOOKING, "done");
    expect(t.runtime.listApprovals()[0]).toMatchObject({
      status: "approved",
      decisionNote: "Approved by your approval policy",
    });
  });

  it("a stricter policy leaves waiting approvals alone", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([`- [ ] ${BOOKING}`]);
    await t.waitForStatus(BOOKING, "waiting_approval");
    setPolicy(t, "ask_every_action");
    expect(t.pendingApprovals()).toHaveLength(1);
    expect(t.record(BOOKING)?.status).toBe("waiting_approval");
    await t.approveNext();
    // The stricter policy asks about the next effectful step too: the agent's own note edit.
    const next = await t.waitForApproval();
    expect(next).toMatchObject({
      toolName: "edit_note",
      reason: "Your approval policy asks before every action.",
    });
    await t.approveNext();
    await t.waitForStatus(BOOKING, "done");
    expectAllGated(t);
  });

  it("asking before every action lets research run and asks before the note edit", async () => {
    const t = await fakeRuntime({
      mode: "live",
      settings: { agent: { approvalPolicy: "ask_every_action" } },
    });
    const task = "Compare flights to Denver for Thanksgiving";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const approval = await t.waitForApproval({ task });
    expect(approval).toMatchObject({
      toolName: "edit_note",
      reason: "Your approval policy asks before every action.",
    });
    const asked = t.audit.gate.filter((g) => g.decision === undefined).map((g) => g.toolName);
    expect(asked).toEqual(["edit_note"]);
    // Searching, fetching and the thread tools ran without asking.
    expect(t.audit.gate.filter((g) => g.decision?.allow).map((g) => g.toolName)).toEqual(
      expect.arrayContaining(["web_search", "web_fetch"]),
    );

    // Asking for risky actions wouldn't ask about the agent's own note edit: switching approves it.
    setPolicy(t, "ask_risky");
    const done = await t.waitForStatus(task, "done");
    expect(done.summary).toBe("Summary ready");
    expect(t.runtime.listApprovals()).toEqual([
      expect.objectContaining({
        toolName: "edit_note",
        status: "approved",
        decisionNote: "Approved by your approval policy",
      }),
    ]);
    expect(t.toolCalls(task).map((m) => `${m.toolName}:${m.status}`)).toContain("edit_note:ok");
    expectAllGated(t);
  });
});
