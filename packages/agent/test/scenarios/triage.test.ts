/**
 * Triage outcomes end to end (fake brain in-process, real runtime and safety stack): delegate,
 * answer, ask, ignore, deferral, harmful tasks, batching, odd task text and follow-up edits.
 */
import { type ArtifactMessage, addDays, ORCHESTRATOR_THREAD_ID, today, toISODate } from "@ddl/core";
import { describe, expect, it } from "vitest";
import {
  expectAllGated,
  expectStatuses,
  fakeRuntime,
  gatedToolsOf,
  orchestratorCallsFor,
  useFakeRuntimes,
} from "./helpers";

useFakeRuntimes();

describe("triage: delegate", () => {
  it("delegates research and finishes with a markdown artifact", async () => {
    const t = await fakeRuntime();
    const task = "Research best standing desks under $500";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "done");

    expectStatuses(t, task, ["triaging", "working", "done"]);
    expect(record.summary).toBe("Summary ready");
    const thread = t.thread(task);
    expect(thread).toMatchObject({ title: task, status: "done", taskId: record.taskId });
    expect(t.texts(task)[0]).toBe("On it — research best standing desks under $500.");
    expect(t.texts(task).at(-1)).toContain("Here's a quick summary");
    const artifact = thread.messages.find((m): m is ArtifactMessage => m.kind === "artifact");
    const body = await t.runtime.readArtifact(thread.id, artifact!.artifactId);
    expect(body?.meta).toMatchObject({ kind: "markdown", title: `Summary: ${task}` });
    expect(new TextDecoder().decode(body!.body)).toContain(`# ${task}`);
    expect(orchestratorCallsFor(t, task)).toEqual(["post_comment", "spawn_subagent"]);
    expect(gatedToolsOf(t, task)).toEqual(["post_update", "create_artifact", "finish_task"]);
    expect(t.runtime.listApprovals()).toEqual([]);
    expectAllGated(t);
  });

  it("passes sub-bullet notes and the parent task on to the subagent", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([
      "- [ ] Plan Kyoto trip",
      "  - mid-November, 5 nights",
      "  - [ ] Research ryokan options",
      "    - budget around $300 a night",
    ]);
    await t.waitForStatus("Plan Kyoto trip", "done");
    await t.waitForStatus("Research ryokan options", "done");
    const spawn = t.audit.gate.find(
      (g) =>
        g.toolName === "spawn_subagent" &&
        (g.input as { goal?: string }).goal === "Research ryokan options",
    );
    const instructions = (spawn!.input as { instructions?: string }).instructions ?? "";
    expect(instructions).toContain('This is a subtask of "Plan Kyoto trip".');
    expect(instructions).toContain("budget around $300 a night");
    expect(t.digests().join("\n")).toContain(
      '"Research ryokan options" (subtask of "Plan Kyoto trip")',
    );
    expect(t.kickoffs().find((k) => k.includes('Task: "Plan Kyoto trip"'))).toContain(
      '- "mid-November, 5 nights"',
    );
    expectAllGated(t);
  });

  it("keeps two identical tasks apart: two records, two threads", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([
      "- [ ] Research laptops for video editing",
      "- [ ] Research laptops for video editing",
    ]);
    await t.waitFor(() => t.records().filter((r) => r.status === "done").length === 2, {
      what: "both done",
    });
    const records = t.records();
    expect(new Set(records.map((r) => r.taskId)).size).toBe(2);
    expect(new Set(records.map((r) => r.threadId)).size).toBe(2);
    expect(records.map((r) => r.line)).toEqual([0, 1]);
    expectAllGated(t);
  });

  it("handles unicode, emoji and markdown in task text", async () => {
    const t = await fakeRuntime();
    const task =
      "Research 🌱 plant-based café options in Zürich — naïve **cheap** ☕ “quotes” \\ back\\slash";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "done");
    expect(record.text).toBe(task);
    expect(t.thread(task).title).toBe(task);
    expect(t.texts(task)[0]).toContain("🌱 plant-based café options in Zürich");
    expectAllGated(t);
  });

  it("handles a 5,000-character task without breaking any tool limit", async () => {
    const t = await fakeRuntime();
    const task = `Research ${"ergonomic standing desk converters and monitor arms ".repeat(120)}`
      .slice(0, 5_000)
      .trimEnd();
    expect(task.length).toBeGreaterThan(4_990);
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "done");
    expect(record.text).toBe(task);
    expect(t.audit.brainCalls.filter((c) => c.outcome !== "ok")).toEqual([]);
    expectAllGated(t);
  });
});

describe("triage: answer, ask, ignore", () => {
  it("answers a quick question itself, with no subagent", async () => {
    const t = await fakeRuntime();
    const task = "What's the capital of Australia?";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "done");
    expect(record.summary).toBe("Canberra");
    expect(t.texts(task)).toEqual(["Canberra."]);
    expect(orchestratorCallsFor(t, task)).toEqual(["post_comment", "set_task_status"]);
    expect(t.kickoffs()).toEqual([]);
    expectAllGated(t);
  });

  it("computes simple answers (tips, conversions, arithmetic)", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([
      "- [ ] Calculate an 18% tip on $86.40",
      "- [ ] What is (12 + 30) * 2?",
    ]);
    await t.waitForStatus("Calculate an 18% tip on $86.40", "done");
    await t.waitForStatus("What is (12 + 30) * 2?", "done");
    expect(t.texts("Calculate an 18% tip on $86.40")).toEqual(["$15.55 (total $101.95)."]);
    expect(t.texts("What is (12 + 30) * 2?")).toEqual(["(12 + 30) * 2 = 84."]);
  });

  it("answers unknown questions without a lookup tool honestly", async () => {
    const t = await fakeRuntime();
    const task = "What time does Costco close today?";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "done");
    expect(record.summary).toBe("Couldn't look up");
  });

  it("silently ignores chores, exercise and personal calls", async () => {
    const t = await fakeRuntime();
    const tasks = [
      "Go to the gym",
      "Call mom",
      "Do laundry",
      "Walk the dog",
      "Dentist appointment at 3pm",
    ];
    await t.writeDailyNote(tasks.map((task) => `- [ ] ${task}`));
    for (const task of tasks) await t.waitForStatus(task, "ignored");
    expect(t.runtime.listThreads().map((s) => s.id)).toEqual([ORCHESTRATOR_THREAD_ID]);
    expect(t.records().every((r) => r.threadId === null && r.summary === undefined)).toBe(true);
    expect(t.audit.gate.map((g) => g.toolName)).toEqual(
      Array(tasks.length).fill("set_task_status"),
    );
  });

  it("ignores harmful tasks", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote(["- [ ] Hack into the neighbor's wifi"]);
    await t.waitForStatus("Hack into the neighbor's wifi", "ignored");
    expect(t.kickoffs()).toEqual([]);
  });

  it("ignores tasks deferred to a later day, but not links to past days", async () => {
    const t = await fakeRuntime();
    const later = toISODate(addDays(today(), 3));
    const earlier = toISODate(addDays(today(), -3));
    await t.writeDailyNote([
      `- [ ] Research new credit cards [[Daily/${later}]]`,
      `- [ ] Research travel insurance [[Daily/${earlier}]]`,
    ]);
    await t.waitForStatus(`Research new credit cards [[Daily/${later}]]`, "ignored");
    await t.waitForStatus(`Research travel insurance [[Daily/${earlier}]]`, "done");
  });

  it("asks when a task is too vague, then delegates with the user's answer", async () => {
    const t = await fakeRuntime();
    const task = "Figure out the thing";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const waiting = await t.waitForStatus(task, "waiting_user");
    expect(waiting.summary).toContain("Question:");
    expect(t.texts(task)).toEqual(["What exactly do you mean by “Figure out the thing”?"]);

    await t.replyInThread(task, "The quarterly tax estimate for Sam");
    await t.waitForStatus(task, "done");
    const texts = t.texts(task);
    expect(texts).toContain("The quarterly tax estimate for Sam");
    expect(texts).toContain("Got it — The quarterly tax estimate for Sam.");
    const spawn = t.audit.gate.find((g) => g.toolName === "spawn_subagent");
    expect((spawn!.input as { instructions: string }).instructions).toContain(
      'The user replied: "The quarterly tax estimate for Sam".',
    );
    expect(t.kickoffs()[0]).toContain("History of this task's thread");
    expectAllGated(t);
  });

  it("acknowledges a thank-you without starting work", async () => {
    const t = await fakeRuntime();
    const task = "What's the capital of France?";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    await t.replyInThread(task, "Thanks!");
    await t.waitFor(() => t.texts(task).at(-1) === "Thanks — noted.", {
      what: "the acknowledgment",
    });
    await t.waitForStatus(task, "done");
    expect(t.kickoffs()).toEqual([]);
  });
});

describe("triage: batching and follow-up edits", () => {
  it("handles every changed task of a note in one orchestrator turn", async () => {
    const t = await fakeRuntime();
    const tasks = [
      "Compare flights to Denver for Thanksgiving",
      "What's the capital of Japan?",
      "Water the plants",
      "Handle it",
    ];
    await t.writeDailyNote(tasks.map((task) => `- [ ] ${task}`));
    await t.waitForStatus(tasks[0]!, "done");
    await t.waitForStatus(tasks[1]!, "done");
    await t.waitForStatus(tasks[2]!, "ignored");
    await t.waitForStatus(tasks[3]!, "waiting_user");
    const first = t.digests()[0]!;
    for (const task of tasks) expect(first).toContain(JSON.stringify(task));
    // All first calls go out in one response (their order follows the digest's).
    const firstTurn = t.brain.decisions.find((d) => d.role === "orchestrator");
    expect(firstTurn?.turn.toolCalls?.map((c) => c.name).sort()).toEqual([
      "ask_user",
      "post_comment",
      "post_comment",
      "set_task_status",
      "set_task_status",
      "spawn_subagent",
    ]);
  });

  it("ignores cosmetic edits of a finished task", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote(["- [ ] Research standing desks"]);
    await t.waitForStatus("Research standing desks", "done");
    const gateCalls = t.audit.gate.length;
    await t.writeDailyNote(["- [ ] research standing desks."]);
    await t.waitFor(() => t.digests().some((d) => d.includes("[updated]")), {
      what: "the update digest",
    });
    await t.idle();
    expect(t.record("research standing desks.")?.status).toBe("done");
    expect(t.audit.gate.length).toBe(gateCalls);
  });

  it("resumes the finished subagent when the task changes meaningfully", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote(["- [ ] Research standing desks"]);
    await t.waitForStatus("Research standing desks", "done");
    await t.writeDailyNote(["- [ ] Research standing desks under $300"]);
    await t.waitFor(
      () => t.texts("Research standing desks under $300").at(-1)?.startsWith("Updated based on"),
      {
        what: "the resumed subagent's summary",
      },
    );
    await t.waitForStatus("Research standing desks under $300", "done");
    expect(orchestratorCallsFor(t, "Research standing desks under $300")).toEqual([
      "post_comment",
      "spawn_subagent",
      "message_subagent",
    ]);
    expect(t.thread("Research standing desks under $300").title).toBe(
      "Research standing desks under $300",
    );
    expect(t.kickoffs()).toHaveLength(1);
  });

  it("delegates an ignored chore that became actionable (message_subagent fails, spawn instead)", async () => {
    const t = await fakeRuntime();
    const edited = "Go to the gym and research memberships with a pool online";
    await t.writeDailyNote(["- [ ] Go to the gym"]);
    const ignored = await t.waitForStatus("Go to the gym", "ignored");
    // Extending the text keeps the task's identity (a rewrite would be a new task).
    await t.writeDailyNote([`- [ ] ${edited}`]);
    await t.waitForStatus(edited, "done");
    expect(t.record(edited)?.taskId).toBe(ignored.taskId);
    const names = orchestratorCallsFor(t, edited);
    expect(names).toEqual([
      "set_task_status",
      "message_subagent",
      "post_comment",
      "spawn_subagent",
    ]);
    const message = t.audit.gate.find((g) => g.toolName === "message_subagent");
    expect(message?.decision).toEqual({ allow: true });
    expect(
      t.brain.decisions.some((d) =>
        d.request.messages.some(
          (m) => m.role === "tool" && m.content.includes("no subagent right now"),
        ),
      ),
    ).toBe(true);
  });

  it("re-delegates a task that was reopened after it was done", async () => {
    const t = await fakeRuntime({ settings: { agent: { settleMs: 5 } } });
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    // Let the subagent's report reach the orchestrator first: dropping a queued report stalls the
    // orchestrator (reported-bugs.test.ts).
    await t.waitFor(() => t.digests().length >= 2, { what: "the report digest" });
    await t.writeDailyNote([`- [x] ${task}`]);
    // Checking off a finished task changes nothing visible; give the watcher time to settle it
    // (otherwise unchecking cancels out before either change settles).
    await new Promise((resolve) => setTimeout(resolve, 40));
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitFor(() => t.texts(task).includes("Reopened — picking this back up."), {
      what: "the reopen comment",
    });
    await t.waitForStatus(task, "done");
    expect(t.kickoffs().at(-1)).toContain("New assignment for the same task.");
    expectAllGated(t);
  });
});
