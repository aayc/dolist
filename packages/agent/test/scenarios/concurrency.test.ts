/**
 * Load and timing: many tasks at once under the concurrency limit (FIFO), typing within the settle
 * window, settings changed while work runs, pausing and resuming the agent.
 */
import type { TaskAgentRecord } from "@ddl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeAgentRuntime } from "../../src/testing";
import { expectAllGated, fakeRuntime, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Waits until `slots` of the (risky) tasks wait for approval and the rest are queued. Which ones
 * start first is up to the orchestrator, so the split is returned rather than assumed.
 */
async function waitForSplit(t: FakeAgentRuntime, tasks: readonly string[], slots: number) {
  return t.waitFor(
    () => {
      const running = tasks.filter((task) => t.record(task)?.status === "waiting_approval");
      const queued = tasks.filter((task) => t.record(task)?.status === "queued");
      return running.length === slots && queued.length === tasks.length - slots
        ? { running, queued }
        : undefined;
    },
    { what: `${slots} running and ${tasks.length - slots} queued` },
  );
}

describe("concurrency", () => {
  it("runs 25 tasks with at most 3 subagents at a time, first in first out, all finishing", async () => {
    // Streaming at 1ms per word keeps subagents busy long enough for the queue to fill.
    const t = await fakeRuntime({
      settings: { agent: { maxConcurrentSubagents: 3 } },
      wordDelayMs: 1,
    });
    const tasks = Array.from(
      { length: 25 },
      (_, i) => `Research option ${String(i + 1).padStart(2, "0")} for the team offsite`,
    );
    await t.writeDailyNote(tasks.map((task) => `- [ ] ${task}`));
    await t.waitFor(() => tasks.every((task) => t.record(task)?.status === "done"), {
      what: "all 25 done",
      timeoutMs: 10_000,
    });

    // Status events are coalesced, so they bound the peak but may not catch it.
    const statuses = t.events.filter((e) => e.type === "status").map((e) => e.payload);
    expect(Math.max(...statuses.map((s) => s.running))).toBeLessThanOrEqual(3);
    expect(statuses.some((s) => s.queued > 0)).toBe(true);

    // Never more than 3 tasks in "working" at once, reconstructed from the record stream.
    const working = new Set<string>();
    let peak = 0;
    const started: string[] = [];
    for (const event of t.events) {
      if (event.type !== "task.record") continue;
      const record: TaskAgentRecord = event.payload;
      if (record.status === "working") {
        if (!working.has(record.taskId) && !started.includes(record.text))
          started.push(record.text);
        working.add(record.taskId);
      } else working.delete(record.taskId);
      peak = Math.max(peak, working.size);
    }
    expect(peak).toBe(3);
    // FIFO: subagents start in the order they were requested. (The digest's order can differ from
    // the note's; see reported-bugs.test.ts.)
    const spawned = t.audit.gate
      .filter((g) => g.toolName === "spawn_subagent")
      .map((g) => (g.input as { goal: string }).goal);
    expect(started).toEqual(spawned);
    expect([...spawned].sort()).toEqual(tasks);
    const queued = tasks.filter((task) => t.statusesOf(task).includes("queued"));
    expect(queued.length).toBeGreaterThanOrEqual(20);
    // One orchestrator turn triaged all of them.
    expect(t.digests()[0]!.match(/\[added\]/g)).toHaveLength(25);
    await t.idle();
    expect(t.runtime.status()).toMatchObject({ running: 0, queued: 0 });
    expectAllGated(t);
  });

  it("typing within the settle window produces exactly one triage", async () => {
    const t = await fakeRuntime({ settings: { agent: { settleMs: 150 } } });
    const full = "Research standing desks";
    for (let n = 3; n <= full.length; n += 4) {
      await t.writeDailyNote([`- [ ] ${full.slice(0, n)}`]);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await t.writeDailyNote([`- [ ] ${full}`]);
    await t.waitForStatus(full, "done");
    const withTask = t.digests().filter((d) => d.includes("[added]"));
    expect(withTask).toHaveLength(1);
    expect(withTask[0]).toContain(JSON.stringify(full));
    expect(t.kickoffs()).toHaveLength(1);
    expect(t.records()).toHaveLength(1);
  });

  it("editor activity on the task's line postpones triage until the user pauses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = await fakeRuntime({ settings: { agent: { settleMs: 40 } } });
    const path = await t.writeDailyNote(["- [ ] Research standing desks"]);
    for (let i = 0; i < 6; i++) {
      t.runtime.noteEditorActivity(path, 0);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(t.digests()).toEqual([]);
    // The watcher waits out its activity window (1.5 s) after the last keystroke on the line.
    await vi.advanceTimersByTimeAsync(1_600);
    await t.waitForStatus("Research standing desks", "done");
  });

  it("raising the concurrency limit mid-run starts queued work", async () => {
    const t = await fakeRuntime({ settings: { agent: { maxConcurrentSubagents: 1 } } });
    const tasks = [
      "Order printer ink (HP 63XL)",
      "Book a haircut for Saturday",
      "Reserve a table for 4 at Luigi's",
    ];
    await t.writeDailyNote(tasks.map((task) => `- [ ] ${task}`));
    await waitForSplit(t, tasks, 1);
    expect(t.runtime.status()).toMatchObject({ running: 1, queued: 2 });
    t.runtime.updateSettings({
      ...t.settings,
      agent: { ...t.settings.agent, maxConcurrentSubagents: 3 },
    });
    await t.waitFor(() => t.pendingApprovals().length === 3, {
      what: "all three waiting for approval",
    });
    expect(t.runtime.status()).toMatchObject({ running: 3, queued: 0 });
    for (let i = 0; i < 3; i++) await t.approveNext();
    for (const task of tasks) await t.waitForStatus(task, "done");
  });

  it("a reply to a queued task reaches its subagent when it starts", async () => {
    const t = await fakeRuntime({ settings: { agent: { maxConcurrentSubagents: 1 } } });
    const tasks = ["Order printer ink (HP 63XL)", "Book a haircut for Saturday"];
    await t.writeDailyNote(tasks.map((task) => `- [ ] ${task}`));
    const { queued } = await waitForSplit(t, tasks, 1);
    const waiting = queued[0]!;
    await t.replyInThread(waiting, "Any time after 3pm");
    await t.approveNext();
    await t.approveNext({ task: waiting });
    await t.waitForStatus(waiting, "done");
    const kickoff = t.kickoffs().find((k) => k.includes(waiting))!;
    expect(kickoff).toContain(
      'Messages received since this was assigned:\n- The user replied in the thread: "Any time after 3pm"',
    );
    expect(t.texts(waiting).at(-1)).toContain("Adjusted for your notes: Any time after 3pm");
  });

  it("cancelling or checking off queued tasks removes them from the queue", async () => {
    const t = await fakeRuntime({ settings: { agent: { maxConcurrentSubagents: 1 } } });
    const tasks = [
      "Order printer ink (HP 63XL)",
      "Book a haircut for Saturday",
      "Reserve a table for 4 at Luigi's",
    ];
    await t.writeDailyNote(tasks.map((task) => `- [ ] ${task}`));
    const { running, queued } = await waitForSplit(t, tasks, 1);
    const [cancelled, checkedOff] = queued as [string, string];
    await t.runtime.cancelThread(t.thread(cancelled).id);
    await t.writeDailyNote(tasks.map((task) => `- [${task === checkedOff ? "x" : " "}] ${task}`));
    await t.waitForStatus(cancelled, "cancelled");
    await t.waitForStatus(checkedOff, "cancelled");
    expect(t.runtime.status()).toMatchObject({ running: 1, queued: 0 });
    await t.approveNext();
    await t.waitForStatus(running[0]!, "done");
    expect(t.kickoffs()).toHaveLength(1);
  });

  it("finished sessions beyond the warm limit are re-primed with history on reply", async () => {
    const t = await fakeRuntime({ settings: { agent: { maxConcurrentSubagents: 10 } } });
    const tasks = Array.from({ length: 10 }, (_, i) => `Research gift idea number ${i + 1}`);
    await t.writeDailyNote(tasks.map((task) => `- [ ] ${task}`));
    await t.waitFor(() => tasks.every((task) => t.record(task)?.status === "done"), {
      what: "all done",
    });
    await t.idle();
    // Eight sessions stay warm; the first one to finish was disposed.
    const first = t.events.find((e) => e.type === "task.record" && e.payload.status === "done");
    const oldest = first?.type === "task.record" ? first.payload.text : "";
    await t.replyInThread(oldest, "Something under $20 please");
    await t.waitFor(() => t.kickoffs().length === 11, { what: "a re-primed session" });
    expect(t.kickoffs()[10]).toContain("History of this task's thread");
    await t.waitForStatus(oldest, "done");
  });

  it("lowering the settle delay mid-run applies to changes already waiting", async () => {
    const t = await fakeRuntime({ settings: { agent: { settleMs: 60_000 } } });
    await t.writeDailyNote(["- [ ] Research standing desks"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.digests()).toEqual([]);
    t.runtime.updateSettings({ ...t.settings, agent: { ...t.settings.agent, settleMs: 10 } });
    await t.waitForStatus("Research standing desks", "done");
  });

  it("pausing the agent lets running work finish, ignores new edits, and catches up on resume", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote(["- [ ] Book a table for two on Friday"]);
    await t.waitForStatus("Book a table for two on Friday", "waiting_approval");
    await t.runtime.setEnabled(false);
    expect(t.runtime.status().enabled).toBe(false);
    await t.writeDailyNote([
      "- [ ] Book a table for two on Friday",
      "- [ ] Research standing desks",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.record("Research standing desks")).toBeUndefined();

    await t.approveNext();
    await t.waitForStatus("Book a table for two on Friday", "done");
    await t.runtime.setEnabled(true);
    await t.waitForStatus("Research standing desks", "done");
    expect(t.record("Book a table for two on Friday")?.status).toBe("done");
  });

  it("disabling through settings behaves like the pause switch", async () => {
    const t = await fakeRuntime();
    t.runtime.updateSettings({ ...t.settings, agent: { ...t.settings.agent, enabled: false } });
    await t.waitFor(() => t.runtime.status().enabled === false, { what: "the agent to pause" });
    await t.writeDailyNote(["- [ ] Research standing desks"]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.records()).toEqual([]);
    t.runtime.updateSettings({ ...t.settings, agent: { ...t.settings.agent, enabled: true } });
    await t.waitForStatus("Research standing desks", "done");
  });
});
