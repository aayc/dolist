/**
 * Restarts on the same vault: interrupted work becomes retryable, stale approvals are closed,
 * threads and artifacts survive, interrupted triage resumes, and a crash (no clean stop) recovers.
 */
import type { ArtifactMessage } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { RECORDS_PATH } from "../../src/orchestrator/records";
import { APPROVALS_STATE_PATH } from "../../src/safety";
import { expectAllGated, fakeRuntime, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

/** The approval id referenced by the thread's approval message. */
function approvalIdIn(
  t: Awaited<ReturnType<typeof fakeRuntime>>,
  task: string,
): string | undefined {
  const message = t.messages(task).find((m) => m.kind === "approval");
  return message?.kind === "approval" ? message.approvalId : undefined;
}

describe("restarts", () => {
  it("a clean restart mid-approval marks the work interrupted; retry completes it", async () => {
    const t = await fakeRuntime();
    const task = "Book a table for two on Friday";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const waiting = await t.waitForStatus(task, "waiting_approval");
    const messagesBefore = t.messages(task).length;

    await t.restart();
    const record = t.record(task)!;
    expect(record).toMatchObject({
      status: "failed",
      summary: "Interrupted",
      threadId: waiting.threadId,
    });
    expect(t.runtime.listApprovals({ status: "pending" })).toEqual([]);
    // Regression: stop() used to skip flushing the approval broker, losing this approval.
    expect(t.runtime.listApprovals()[0]).toMatchObject({
      status: "cancelled",
      decisionNote: "The agent stopped.",
    });
    expect(t.runtime.getThread(record.threadId!)?.approvals.map((a) => a.id)).toEqual([
      approvalIdIn(t, task),
    ]);
    const thread = t.thread(task);
    expect(thread.messages.length).toBeGreaterThanOrEqual(messagesBefore);
    expect(thread.messages.some((m) => m.kind === "status" && m.text?.includes("Use Retry"))).toBe(
      true,
    );

    await t.runtime.retryThread(record.threadId!);
    await t.approveNext();
    await t.waitForStatus(task, "done");
    expect(t.kickoffs().at(-1)).toContain("This is a retry of an earlier attempt.");
    expectAllGated(t);
  });

  it("threads and artifacts survive a restart", async () => {
    const t = await fakeRuntime();
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const before = t.thread(task);
    await t.restart();
    const after = t.thread(task);
    expect(after.messages).toEqual(before.messages);
    const artifact = after.messages.find((m): m is ArtifactMessage => m.kind === "artifact")!;
    const body = await t.runtime.readArtifact(after.id, artifact.artifactId);
    expect(new TextDecoder().decode(body!.body)).toContain(`# ${task}`);
    expect(t.record(task)?.status).toBe("done");

    // The resumed session is gone, so a reply primes a fresh one with the thread history.
    await t.replyInThread(task, "Only ones with a crank handle");
    await t.waitFor(() => t.kickoffs().length === 2, { what: "a new session" });
    expect(t.kickoffs()[1]).toContain("History of this task's thread");
    await t.waitForStatus(task, "done");
  });

  it("a restart during triage re-triages the task on start", async () => {
    const t = await fakeRuntime();
    t.brain.hang({ role: "orchestrator" });
    const task = "Research ergonomic office chairs";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "triaging");
    await t.waitFor(() => t.brain.decisions.some((d) => d.label === "hang"), { what: "the hang" });
    await t.restart();
    await t.waitForStatus(task, "done");
  });

  it("recovers from a crash: active work fails as interrupted and the pending approval expires", async () => {
    const t = await fakeRuntime();
    const task = "Order new running shoes";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "waiting_approval");
    // The sidecar state is written with a short debounce; "crash" only once it is on disk.
    for (let i = 0; ; i++) {
      const records = await t.storage.read(RECORDS_PATH);
      const approvals = await t.storage.read(APPROVALS_STATE_PATH);
      if (
        records?.content.includes('"waiting_approval"') &&
        approvals?.content.includes('"pending"')
      )
        break;
      if (i > 200) throw new Error("the sidecar state was never persisted");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await t.restart({ crash: true });
    expect(t.record(task)).toMatchObject({ status: "failed", summary: "Interrupted" });
    expect(t.runtime.listApprovals()[0]).toMatchObject({
      status: "expired",
      decisionNote: "The app restarted before a decision was made.",
    });
    expect(t.runtime.listApprovals({ status: "pending" })).toEqual([]);
  });
});
