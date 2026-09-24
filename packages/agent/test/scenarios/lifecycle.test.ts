/**
 * The life of a task's work: cancellation (delete, check off, cancelThread), steering while it runs
 * (edits, replies), resuming after it finished, retries, and recovery from tool errors, invalid
 * arguments, unknown tools, and failing or hanging model calls.
 */
import { describe, expect, it } from "vitest";
import { createFakeWeb } from "../../src/testing";
import {
  expectAllGated,
  expectStatuses,
  fakeRuntime,
  subagentFor,
  useFakeRuntimes,
} from "./helpers";

useFakeRuntimes();

describe("cancellation", () => {
  it("deleting a task aborts its running subagent and forgets the task", async () => {
    const t = await fakeRuntime();
    t.brain.hang({ role: subagentFor("Plan anniversary trip to Kyoto") });
    await t.writeDailyNote(["- [ ] Plan anniversary trip to Kyoto", "- [ ] Renew passport"]);
    const working = await t.waitForStatus("Plan anniversary trip to Kyoto", "working");
    await t.waitFor(() => t.brain.decisions.some((d) => d.label === "hang"), {
      what: "the subagent to be mid-call",
    });
    await t.writeDailyNote(["- [ ] Renew passport"]);
    await t.waitFor(() => t.record("Plan anniversary trip to Kyoto") === undefined, {
      what: "the record to go",
    });
    expect(t.runtime.getThread(working.threadId!)?.thread.status).toBe("cancelled");
    await t.waitForStatus("Renew passport", "done");
    await t.idle();
    expect(t.runtime.status()).toMatchObject({ running: 0, queued: 0 });
  });

  it("checking a task off cancels its running subagent", async () => {
    const t = await fakeRuntime();
    t.brain.hang({ role: "subagent" });
    const task = "Research ergonomic office chairs";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitFor(() => t.brain.decisions.some((d) => d.label === "hang"), { what: "the hang" });
    await t.writeDailyNote([`- [x] ${task}`]);
    const record = await t.waitForStatus(task, "cancelled");
    expect(t.messages(task).some((m) => m.kind === "status" && m.status === "cancelled")).toBe(
      true,
    );
    expect(record.summary).toBe("Cancelled");
  });

  it("cancelThread stops a running subagent", async () => {
    const t = await fakeRuntime();
    t.brain.hang({ role: "subagent" });
    const task = "Research ergonomic office chairs";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitFor(() => t.brain.decisions.some((d) => d.label === "hang"), { what: "the hang" });
    await t.runtime.cancelThread(t.thread(task).id);
    await t.waitForStatus(task, "cancelled");
    expect(t.runtime.status().running).toBe(0);
  });
});

describe("steering and resuming", () => {
  it("an edit while the subagent runs is delivered to it and folded into the result", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote(["- [ ] Book a table for two on Friday"]);
    const waiting = await t.waitForStatus("Book a table for two on Friday", "waiting_approval");
    await t.writeDailyNote(["- [ ] Book a table for two on Friday at 8pm"]);
    await t.waitFor(() => t.thread("Book a table for two on Friday at 8pm").title.endsWith("8pm"), {
      what: "the thread title to follow the edit",
    });
    await t.approveNext();
    const record = await t.waitForStatus("Book a table for two on Friday at 8pm", "done");
    expect(record.taskId).toBe(waiting.taskId);
    expect(t.texts("Book a table for two on Friday at 8pm").at(-1)).toContain(
      "Adjusted for your notes: the task now reads “Book a table for two on Friday at 8pm”",
    );
    // The edit went to the running subagent, not through another orchestrator turn.
    expect(t.digests().filter((d) => d.includes("[updated]"))).toEqual([]);
    expect(t.kickoffs()).toHaveLength(1);
  });

  it("a reply while the subagent runs steers it", async () => {
    const t = await fakeRuntime();
    const task = "Book a table for two on Friday";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "waiting_approval");
    await t.replyInThread(task, "Somewhere with outdoor seating please");
    await t.approveNext();
    await t.waitForStatus(task, "done");
    const texts = t.texts(task);
    expect(texts).toContain("Somewhere with outdoor seating please");
    expect(texts.some((m) => m.startsWith("Noted — Somewhere with outdoor seating please."))).toBe(
      true,
    );
    expect(texts.at(-1)).toContain(
      "Adjusted for your notes: Somewhere with outdoor seating please",
    );
  });

  it("a reply after the work is done resumes the same session with its context", async () => {
    const t = await fakeRuntime();
    const task = "Research best standing desks under $500";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    await t.replyInThread(task, "Only ones with a crank handle");
    await t.waitFor(
      () =>
        t
          .texts(task)
          .at(-1)
          ?.startsWith("Updated based on your message: Only ones with a crank handle"),
      {
        what: "the follow-up summary",
      },
    );
    const record = await t.waitForStatus(task, "done");
    expect(record.summary).toBe("Updated");
    expect(t.texts(task)).toContain("Got it — Only ones with a crank handle");
    expect(t.kickoffs()).toHaveLength(1);
    const last = t.brain.decisions.filter((d) => d.role === "subagent").at(-1)!;
    expect(
      last.request.messages.some((m) => m.role === "tool" && m.name === "create_artifact"),
    ).toBe(true);
  });
});

describe("retries and recovery", () => {
  it("a failed subagent can be retried and finishes the second time", async () => {
    const t = await fakeRuntime();
    t.brain.fail({ role: "subagent", message: "upstream model overloaded" });
    const task = "Compare flights to Denver for Thanksgiving";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const failed = await t.waitForStatus(task, "failed");
    expect(failed.summary).toBe("Failed: upstream model overloaded");
    await t.runtime.retryThread(failed.threadId!);
    await t.waitForStatus(task, "done");
    expectStatuses(t, task, ["working", "failed", "working", "done"]);
    const kickoffs = t.kickoffs();
    expect(kickoffs).toHaveLength(2);
    expect(kickoffs[1]).toContain("This is a retry of an earlier attempt.");
    expect(t.texts(task)).toContain(
      "Picking “Compare flights to Denver for Thanksgiving” back up — reviewing what was done before.",
    );
  });

  it("invalid tool arguments are reported to the model (not the gate) and re-issued", async () => {
    const t = await fakeRuntime();
    t.brain.corruptToolArgs({ tool: "create_artifact", mode: "schema" });
    t.brain.corruptToolArgs({ tool: "post_update", mode: "invalid-json" });
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const calls = t.audit.brainCalls.filter(
      (c) => c.name === "create_artifact" || c.name === "post_update",
    );
    expect(calls.map((c) => `${c.name}:${c.outcome}`)).toEqual([
      "post_update:invalid",
      "post_update:ok",
      "create_artifact:invalid",
      "create_artifact:ok",
    ]);
    expect(calls[0]!.toolCallId).toBeUndefined();
    expect(calls[0]!.content).toMatch(/^Validation failed for tool "post_update"/);
    expect(t.audit.gate.filter((g) => g.toolName === "create_artifact")).toHaveLength(1);
    expectAllGated(t);
  });

  it("a call to a tool that doesn't exist is reported and the agent carries on", async () => {
    const t = await fakeRuntime();
    t.brain.unknownTool({ role: "subagent" });
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, "done");
    const unknown = t.audit.brainCalls.find((c) => c.name === "no_such_tool");
    expect(unknown).toMatchObject({ outcome: "invalid", content: "Tool no_such_tool not found" });
    expect(t.audit.gate.some((g) => g.toolName === "no_such_tool")).toBe(false);
  });

  it("recovers when one research source fails and another works (live mode, real web tools)", async () => {
    const failing = "https://www.example.com/guides/compare-flights-to-denver-for-thanksgiving";
    const t = await fakeRuntime({
      mode: "live",
      web: createFakeWeb({ [failing]: { status: 500, body: "<h1>Internal error</h1>" } }),
    });
    const task = "Compare flights to Denver for Thanksgiving";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "done");
    expect(record.summary).toBe("Summary ready");
    expect(t.toolCalls(task).map((m) => `${m.toolName}:${m.status}`)).toEqual([
      "web_search:ok",
      "web_fetch:error",
      "edit_note:ok",
    ]);
    expect(t.web.fetched).toEqual([failing]);
    expectAllGated(t);
  });

  it("finishes as failed with an explanation when every research source fails", async () => {
    const t = await fakeRuntime({ mode: "live" });
    t.brain.fail({ role: "web_search", times: 10, message: "search backend down" });
    const task = "Compare flights to Denver for Thanksgiving";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "failed");
    expect(record.summary).toBe("web_search error");
    expect(t.texts(task).at(-1)).toContain(
      "web_search failed (Web search failed: OpenRouter 500: search backend down)",
    );
    expect(t.toolCalls(task).map((m) => m.status)).toEqual(["error"]);
  });

  it("an orchestrator failure marks the task failed; retry triages it again", async () => {
    const t = await fakeRuntime();
    t.brain.fail({ role: "orchestrator", message: "model unavailable" });
    const task = "Research ergonomic office chairs";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const failed = await t.waitForStatus(task, "failed");
    expect(failed.summary).toBe("Couldn't triage");
    expect(t.runtime.status().problem).toContain("model unavailable");
    await t.runtime.retryThread(failed.threadId!);
    await t.waitForStatus(task, "done");
    await t.waitFor(() => t.runtime.status().problem === undefined, {
      what: "the problem to clear",
    });
  });

  it("an orchestrator turn that hangs past the timeout fails its tasks; retry works", async () => {
    const t = await fakeRuntime({ overrides: { turnTimeoutMs: 100 } });
    t.brain.hang({ role: "orchestrator" });
    const task = "Research ergonomic office chairs";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const failed = await t.waitForStatus(task, "failed");
    expect(t.runtime.status().problem).toContain("took too long");
    await t.runtime.retryThread(failed.threadId!);
    await t.waitForStatus(task, "done");
  });

  it("an empty turn from the subagent gets the finish nudge, then it wraps up", async () => {
    const t = await fakeRuntime();
    t.brain.enqueueFor("subagent", {});
    const task = "Research standing desks";
    await t.writeDailyNote([`- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "done");
    expect(record.summary).toBe("Summary ready");
    const nudged = t.brain.decisions.some((d) =>
      d.request.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.startsWith("You ended your turn without calling finish_task"),
      ),
    );
    expect(nudged).toBe(true);
  });
});
