/**
 * Bugs found by the fake-agent scenarios in modules owned by other slices. Each test states the
 * expected behavior and is marked `it.fails` until the owning module is fixed; when a fix lands,
 * vitest reports the test as unexpectedly passing — then drop `.fails`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatOrchestratorDigest } from "../../src/prompts/orchestrator";
import { fakeRuntime, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

describe("reported bugs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // BUG (src/orchestrator/orchestrator.ts, severe): startDrain() runs
  // `this.draining = (async () => { … finally { this.draining = null } })()`. When the queue is
  // empty on entry — every queued item was dropped before the batch timer fired, e.g. the user
  // checked off (or deleted, or cancelled) a task within `reportDelayMs` (1.5 s) of its subagent
  // finishing — the async body completes synchronously, its `finally` clears `draining`, and the
  // assignment then stores the settled promise for good. scheduleDrain() bails out from then on:
  // nothing is triaged again until the daemon restarts. (Assigning before the body runs, or
  // clearing only `if (this.draining === run)`, fixes it.)
  it.fails("the orchestrator keeps triaging after a queued report is dropped", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const t = await fakeRuntime({ overrides: { reportDelayMs: 1_500 } });
    await t.writeDailyNote(["- [ ] Research standing desks"]);
    const done = await t.waitForStatus("Research standing desks", "done");
    await t.idle();
    // The finished subagent's report now waits 1.5 s for the orchestrator; cancelling drops it.
    await t.runtime.cancelThread(done.threadId!);
    await vi.advanceTimersByTimeAsync(2_000);

    await t.writeDailyNote(["- [ ] Research standing desks", "- [ ] Research monitor arms"]);
    await t.waitForStatus("Research monitor arms", "done", { timeoutMs: 1_000 });
  });

  // BUG (src/prompts/orchestrator.ts): `buildDigest` fills `agentStatus` for updated tasks, but
  // `formatOrchestratorDigest` never renders it for changed tasks. The prompt tells the model to
  // `message_subagent` "if a subagent already finished the task", which it cannot know — so it
  // guesses (the fake orchestrator has to try message_subagent and fall back to spawning).
  it.fails("the digest tells the orchestrator the agent status of an updated task", () => {
    const digest = formatOrchestratorDigest({
      now: Date.now(),
      notes: [
        {
          notePath: "Daily/2026-09-23.md",
          date: null,
          changed: [
            {
              taskId: "tsk_1",
              text: "Research standing desks under $300",
              previousText: "Research standing desks",
              change: "updated",
              notes: [],
              agentStatus: "done",
            },
          ],
          others: [],
        },
      ],
      replies: [],
      reports: [],
      subagents: [],
      capabilities: { available: ["web"], unavailable: [], connectors: [] },
    });
    expect(digest).toMatch(/\[updated\] tsk_1: .*agent: done/);
  });

  // BUG (src/orchestrator/subagents.ts ↔ apps/web badgeLabel): a crashed run's record summary is
  // "Failed: <error>", but the UI already renders failed badges as "Failed · <summary>", so users
  // see "Failed · Failed: …". Summaries should carry only the detail.
  it.fails("a failed run's badge summary doesn't repeat the status", async () => {
    const t = await fakeRuntime();
    t.brain.fail({ role: "subagent", message: "upstream model overloaded" });
    await t.writeDailyNote(["- [ ] Research ergonomic office chairs"]);
    const record = await t.waitForStatus("Research ergonomic office chairs", "failed");
    expect(record.summary).not.toMatch(/^failed\b/i);
  });

  // BUG (src/orchestrator/task-watcher.ts + orchestrator.ts): tasks written together settle on
  // timers of `due - now()`; when scheduling straddles a millisecond, later tasks get shorter delays
  // and settle first, and `buildDigest` keeps settle order. Under load a list is then triaged (and
  // its subagents queued) out of order. A clock that ticks on every read reproduces it reliably.
  it.fails("a note's tasks reach the orchestrator in list order", async () => {
    let clock = Date.now();
    const t = await fakeRuntime({ now: () => clock++ });
    const tasks = [
      "Research option A",
      "Research option B",
      "Research option C",
      "Research option D",
    ];
    await t.writeDailyNote(tasks.map((task) => `- [ ] ${task}`));
    await t.waitFor(() => t.digests()[0], { what: "the first digest" });
    const order = [...t.digests()[0]!.matchAll(/\[added\] \S+: "([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(tasks);
  });

  // BUG (src/orchestrator/task-board.ts): `setStatus(taskId, status, { note })` updates the record
  // (emitting `task.record`) before it creates the thread for the note, so clients first receive
  // e.g. `failed` with `threadId: null` and only then the record with the thread — a torn state.
  it.fails("a status change that opens the thread is announced with the thread attached", async () => {
    const t = await fakeRuntime();
    t.brain.fail({ role: "orchestrator", message: "model unavailable" });
    await t.writeDailyNote(["- [ ] Research ergonomic office chairs"]);
    await t.waitForStatus("Research ergonomic office chairs", "failed");
    const firstFailed = t.events.find(
      (e) => e.type === "task.record" && e.payload.status === "failed",
    );
    expect(firstFailed?.type === "task.record" && firstFailed.payload.threadId).toBeTruthy();
  });
});
