/**
 * Approval flows with the real safety evaluator, gate and (persisting) approval broker: approve,
 * deny, expire, standing "approve for this task" grants, re-asking after a denial, several pending
 * approvals, cancellation while waiting, and policy blocks that never ask.
 */
import type { ToolCallMessage } from "@ddl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectAllGated, expectStatuses, fakeRuntime, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

afterEach(() => {
  vi.useRealTimers();
});

describe("approvals", () => {
  it("pauses the irreversible step for approval and completes once approved", async () => {
    const t = await fakeRuntime();
    const task = "Book a table for two on Friday";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const waiting = await t.waitForStatus(task, "waiting_approval");
    // Badges are cut to 60 characters.
    expect(waiting.summary).toBe("Approve: Mock book: book for “Book a table for two on Frida…");
    const [approval] = t.pendingApprovals();
    expect(approval).toMatchObject({
      toolName: "mock_irreversible_action",
      categories: ["booking"],
      taskId: waiting.taskId,
      threadId: t.thread(task).id,
      status: "pending",
    });
    expect(
      t.messages(task).some((m) => m.kind === "approval" && m.approvalId === approval!.id),
    ).toBe(true);
    expect(t.runtime.status().pendingApprovals).toBe(1);

    await t.approveNext();
    const done = await t.waitForStatus(task, "done");
    expect(done.summary).toBe("Booked (mock)");
    expectStatuses(t, task, ["triaging", "working", "waiting_approval", "working", "done"]);
    const tool = t.toolCalls(task).find((m) => m.toolName === "mock_irreversible_action");
    expect(tool).toMatchObject({ status: "ok" });
    expect(
      t.events.filter((e) => e.type === "approval.upsert").map((e) => e.payload.status),
    ).toEqual(["pending", "approved"]);
    expect(t.runtime.status().pendingApprovals).toBe(0);
    expectAllGated(t);
  });

  it("reports a denied action as blocked and asks the user how to proceed", async () => {
    const t = await fakeRuntime();
    const task = "Email landlord about the leaky faucet";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "waiting_approval");
    await t.denyNext("Not now");
    const record = await t.waitForStatus(task, "waiting_user");
    expect(record.summary).toBe("Not approved");
    expect(t.toolCalls(task).find((m) => m.toolName === "mock_irreversible_action")?.status).toBe(
      "blocked",
    );
    expect(t.texts(task).at(-1)).toBe(
      "I prepared everything but didn't email because it wasn't approved (User denied: Not now).",
    );
    expect(t.runtime.listApprovals()[0]).toMatchObject({
      status: "denied",
      decisionNote: "Not now",
    });
    expectAllGated(t);
  });

  it("expires an approval nobody decides (fake timers) and reports it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = await fakeRuntime({ advanceTimers: (ms) => vi.advanceTimersByTimeAsync(ms) });
    const task = "Order new running shoes";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const [approval] = [await t.waitForApproval()];
    expect(approval!.expiresAt! - approval!.createdAt).toBe(t.settings.agent.approvalTimeoutMs);
    await t.advance(t.settings.agent.approvalTimeoutMs + 1_000);
    const record = await t.waitForStatus(task, "waiting_user");
    expect(record.summary).toBe("Not approved");
    expect(t.runtime.listApprovals()[0]?.status).toBe("expired");
    expect(t.texts(task).at(-1)).toContain("(Approval expired)");
  });

  it("'approve for this task' covers the next matching call of that task only", async () => {
    const t = await fakeRuntime();
    // Make the subagent perform a second irreversible call right after the first one succeeds.
    t.brain.when(
      (_request, info) =>
        info.role === "subagent" &&
        info.callsSinceUser.filter((c) => c.name === "mock_irreversible_action").length === 1 &&
        info.callsSinceUser.at(-1)?.name === "mock_irreversible_action",
      {
        toolCalls: [
          {
            name: "mock_irreversible_action",
            arguments: { action: "book", details: "a second table" },
          },
        ],
      },
      { times: 1, name: "second booking" },
    );
    const task = "Book a table for two on Friday";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.approveNext({ scope: "task" });
    await t.waitForStatus(task, "done");
    const approvals = t.runtime.listApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ status: "approved", scope: "task" });
    const risky = t.audit.gate.filter((g) => g.toolName === "mock_irreversible_action");
    expect(risky.map((g) => g.verdict?.source)).toEqual(["policy", "grant"]);
    expect(
      t
        .toolCalls(task)
        .filter((m) => m.toolName === "mock_irreversible_action")
        .map((m) => m.status),
    ).toEqual(["ok", "ok"]);

    // The grant is scoped to that task: another booking still asks.
    await t.writeDailyNote([`- [ ] ${task}`, "- [ ] Book a haircut for Saturday"]);
    await t.waitForStatus("Book a haircut for Saturday", "waiting_approval");
    expect(t.pendingApprovals()).toHaveLength(1);
    expectAllGated(t);
  });

  it("asks again when the user says 'go ahead' after a denial, and completes", async () => {
    const t = await fakeRuntime();
    const task = "Book a table for two on Friday";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.denyNext("Wait, let me check with Alex");
    await t.waitForStatus(task, "waiting_user");
    await t.replyInThread(task, "Alex is in — go ahead and book it");
    await t.waitForStatus(task, "waiting_approval");
    await t.approveNext();
    const record = await t.waitForStatus(task, "done");
    expect(record.summary).toBe("Booked (mock)");
    expect(t.runtime.listApprovals().map((a) => a.status)).toEqual(["denied", "approved"]);
    expect(t.texts(task)).toContain("Okay — trying to book again.");
    expectAllGated(t);
  });

  it("keeps approvals of different tasks independent, decided in reverse order", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([
      "- [ ] Order printer ink (HP 63XL)",
      "- [ ] Reserve a table for 4 at Luigi's",
    ]);
    await t.waitForStatus("Order printer ink (HP 63XL)", "waiting_approval");
    await t.waitForStatus("Reserve a table for 4 at Luigi's", "waiting_approval");
    expect(t.pendingApprovals()).toHaveLength(2);
    await t.approveNext({ task: "Reserve a table for 4 at Luigi's" });
    await t.waitForStatus("Reserve a table for 4 at Luigi's", "done");
    expect(t.record("Order printer ink (HP 63XL)")?.status).toBe("waiting_approval");
    await t.denyNext("Too expensive", { task: "Order printer ink (HP 63XL)" });
    await t.waitForStatus("Order printer ink (HP 63XL)", "waiting_user");
    await t.idle();
    expect(t.runtime.status()).toMatchObject({ running: 0, pendingApprovals: 0 });
    expectAllGated(t);
  });

  it("cancelThread while waiting cancels the approval and the work", async () => {
    const t = await fakeRuntime();
    const task = "Reserve a table for Friday";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "waiting_approval");
    await t.runtime.cancelThread(t.thread(task).id);
    const record = await t.waitForStatus(task, "cancelled");
    expect(record.summary).toBe("Cancelled");
    expect(t.runtime.listApprovals()[0]).toMatchObject({
      status: "cancelled",
      decisionNote: "Cancelled by you.",
    });
    expect(t.runtime.status()).toMatchObject({ running: 0, pendingApprovals: 0 });
    const tool = t
      .toolCalls(task)
      .find((m): m is ToolCallMessage => m.toolName === "mock_irreversible_action");
    expect(tool?.status).not.toBe("running");
    await expect(
      t.runtime.decideApproval(t.runtime.listApprovals()[0]!.id, { decision: "approve" }),
    ).rejects.toThrow(/already cancelled/);
  });

  it("checking the task off while waiting cancels the approval", async () => {
    const t = await fakeRuntime();
    const task = "Order new running shoes";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "waiting_approval");
    await t.writeDailyNote([`- [x] ${task}`]);
    const record = await t.waitForStatus(task, "cancelled");
    expect(t.runtime.listApprovals()[0]?.status).toBe("cancelled");
    expect(t.runtime.getThread(record.threadId!)?.thread.status).toBe("cancelled");
  });

  it("deleting the task while waiting cancels the approval and forgets the task", async () => {
    const t = await fakeRuntime();
    const task = "Order new running shoes";
    await t.writeDailyNote([`- [ ] ${task}`, "- [ ] Water the plants"]);
    const waiting = await t.waitForStatus(task, "waiting_approval");
    await t.writeDailyNote(["- [ ] Water the plants"]);
    await t.waitFor(() => t.record(task) === undefined, { what: "the record to be removed" });
    expect(t.runtime.listApprovals()[0]?.status).toBe("cancelled");
    expect(t.runtime.getThread(waiting.threadId!)?.thread.status).toBe("cancelled");
    expect(t.record("Water the plants")?.status).toBe("ignored");
  });

  it("a policy that denies the tool blocks it without asking, and the agent reports it", async () => {
    const t = await fakeRuntime({
      safetyPolicy: { alwaysDenyTools: ["mock_irreversible_action"] },
    });
    const task = "Pay parking ticket #A12345 online";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "waiting_user");
    expect(record.summary).toBe("Not approved");
    expect(t.runtime.listApprovals()).toEqual([]);
    expect(t.texts(task).at(-1)).toContain(
      "mock_irreversible_action is blocked by your safety policy",
    );
    expect(
      t.audit.gate.find((g) => g.toolName === "mock_irreversible_action")?.verdict,
    ).toMatchObject({
      decision: "deny",
      source: "policy",
    });
    expectAllGated(t);
  });
});
