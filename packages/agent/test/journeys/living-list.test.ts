/**
 * User journeys for the living to-do list (docs/USER_JOURNEYS.md), run end to end on the real
 * runtime with the scripted brain: the watcher, the orchestrator with its whole-note view, anchors,
 * subagents writing into the note, citations and the safety gate.
 */
import { describe, expect, it } from "vitest";
import type { FakeAgentRuntime } from "../../src/testing";
import {
  expectAllGated,
  expectStatuses,
  fakeRuntime,
  subagentFor,
  useFakeRuntimes,
} from "../scenarios/helpers";

useFakeRuntimes();

const read = async (t: FakeAgentRuntime) => (await t.storage.read(t.notePath()))!.content;
/** Polls today's note (the agent writes it asynchronously) until `pick` returns something. */
async function waitForNote<T>(
  t: FakeAgentRuntime,
  pick: (lines: string[]) => T | undefined,
  what: string,
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const found = pick((await read(t)).split("\n"));
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}:\n${await read(t)}`);
}
const anchorDone = (t: FakeAgentRuntime) =>
  t.waitFor(() => t.records().find((r) => r.anchor === "line" && r.status === "done"), {
    what: "the line's thread to be answered",
  });

describe("J1: a task comes alive", () => {
  it("is triaged, worked on, and leaves its outcome in the note as the agent's cited line", async () => {
    const t = await fakeRuntime({ mode: "live" });
    const task = "Research the best espresso grinders under $300";
    await t.writeDailyNote(["# Thursday", `- [ ] ${task}`]);
    const record = await t.waitForStatus(task, "done");
    expectStatuses(t, task, ["triaging", "working", "done"]);
    expect(record.summary).toBe("Summary ready");

    const thread = t.thread(task);
    const agentLine = (await read(t)).split("\n").find((l) => l.endsWith(`%%agent:${thread.id}%%`));
    expect(agentLine).toMatch(
      /^ {2}- Summary ready \(mock\) — best source: \[[^\]]+\]\(https:\/\/[^)]+\) %%agent:/,
    );
    const url = /\]\((https:[^)]+)\)/.exec(agentLine!)![1]!;
    expect(thread.sources?.find((source) => source.url === url)?.title).toBeTruthy();

    // The agent's line is not a new request.
    await t.idle();
    expect(t.records().map((r) => r.text)).toEqual([task]);
    expectAllGated(t);
  });
});

describe("J2: a question written as prose", () => {
  it("gets a thread on its own line, a badge with the answer, and the answer under it", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote(["# Thursday", "What's the capital of Australia?"]);
    const anchor = await anchorDone(t);
    expect(anchor).toMatchObject({
      text: "What's the capital of Australia?",
      line: 1,
      summary: expect.stringContaining("Canberra"),
    });
    expect(anchor.taskId).toMatch(/^anc_/);
    const answer = await waitForNote(
      t,
      (lines) => (lines[2]?.endsWith(`%%agent:${anchor.threadId}%%`) ? lines[2] : undefined),
      "the answer under the question",
    );
    expect(answer).toContain("Canberra");
    const thread = t.runtime.getThread(anchor.threadId!)!.thread;
    expect(thread.title).toBe("What's the capital of Australia?");
    expect(thread.messages.some((m) => m.kind === "text" && m.text.includes("Canberra"))).toBe(
      true,
    );
    expectAllGated(t);
  });

  it("follows its line while the user writes around it, and goes away with the line", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote(["What's the capital of Japan?"]);
    await anchorDone(t);
    await t.writeDailyNote(`# Thursday\nMorning pages\n${await read(t)}`);
    await t.waitFor(() => t.records().find((r) => r.anchor === "line")?.line === 2, {
      what: "the anchor to move down two lines",
    });
    const kept = (await read(t)).split("\n").filter((l) => !/Japan|Tokyo/.test(l));
    await t.writeDailyNote(kept.join("\n"));
    await t.waitFor(() => !t.records().some((r) => r.anchor === "line"), {
      what: "the anchor to go with its line",
    });
  });

  it("an answer from the web cites its source, and the thread keeps what the agent saw of it", async () => {
    const t = await fakeRuntime({ mode: "live" });
    await t.writeDailyNote(["What's the tallest building in NYC?"]);
    const anchor = await anchorDone(t);
    const thread = t.runtime.getThread(anchor.threadId!)!.thread;
    const comment = thread.messages.find((m) => m.kind === "text" && m.role === "agent");
    const url = /\]\((https:[^)]+)\)/.exec(comment?.kind === "text" ? comment.text : "")?.[1];
    expect(url).toBeDefined();
    expect(thread.sources?.find((s) => s.url === url)).toMatchObject({
      url,
      title: expect.any(String),
    });
    const agentLine = await waitForNote(
      t,
      (lines) => lines.find((l) => l.endsWith(`%%agent:${thread.id}%%`)),
      "the cited answer in the note",
    );
    expect(agentLine).toContain(`](${url})`);
  });
});

describe("J3: the user's own notes stay theirs", () => {
  it("journaling never wakes the orchestrator", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote(["# Thursday", "Slept badly, lots of meetings."]);
    await t.writeDailyNote([
      "# Thursday",
      "Slept badly, lots of meetings.",
      "Lunch with Sam was great.",
    ]);
    await t.idle();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(t.digests()).toEqual([]);
    expect(t.records()).toEqual([]);
  });

  it("changing the user's words pauses for approval, and a denial leaves them as they were", async () => {
    const t = await fakeRuntime();
    const task = "Plan the team offsite";
    t.brain.when(
      subagentFor(task),
      {
        toolCalls: [
          {
            name: "edit_note",
            arguments: {
              edits: [
                { op: "replace", line: 2, expect: "  - budget $2k", text: "- budget $2,500" },
              ],
            },
          },
        ],
      },
      { times: 1 },
    );
    await t.writeDailyNote([`- [ ] ${task}`, "  - budget $2k"]);
    const approval = await t.waitForApproval({ task });
    expect(approval.summary).toContain("budget $2k");
    expect(approval.categories).toContain("file_write");
    await t.denyNext("keep my budget");
    await t.waitForStatus(task, ["done", "waiting_user", "failed"]);
    const note = await read(t);
    expect(note).toContain("  - budget $2k");
    expect(note).not.toContain("2,500");
    expectAllGated(t);
  });

  it("an approved change goes in, marked as the agent's", async () => {
    const t = await fakeRuntime();
    const task = "Plan the team offsite";
    t.brain.when(
      subagentFor(task),
      {
        toolCalls: [
          {
            name: "edit_note",
            arguments: {
              edits: [
                { op: "replace", line: 2, expect: "  - budget $2k", text: "- budget $2,500" },
              ],
            },
          },
        ],
      },
      { times: 1 },
    );
    await t.writeDailyNote([`- [ ] ${task}`, "  - budget $2k"]);
    await t.approveNext({ task });
    const edited = await waitForNote(
      t,
      (lines) => lines.find((l) => l.startsWith("  - budget $2,500 %%agent:thr_")),
      "the approved edit",
    );
    expect(edited).toMatch(/^ {2}- budget \$2,500 %%agent:thr_\w+%%$/);
    expect(await read(t)).not.toContain("$2k");
    expectAllGated(t);
  });
});

describe("J4: the agent's own tasks", () => {
  it("aren't triaged as requests until the user deletes the marker and makes them theirs", async () => {
    const t = await fakeRuntime();
    const task = "Research ramen places near the office";
    await t.writeDailyNote([`- [ ] ${task} %%agent:thr_seed%%`]);
    await t.idle();
    expect(t.records()).toEqual([]);
    expect(t.digests()).toEqual([]);
    await t.writeDailyNote([`- [ ] ${task}`]);
    await t.waitForStatus(task, ["working", "done"]);
    expectAllGated(t);
  });
});

describe("J5: the orchestrator sees the whole note", () => {
  it("as a numbered view with each line's id, status and whether the agent wrote it", async () => {
    const t = await fakeRuntime();
    const task = "Research espresso grinders";
    await t.writeDailyNote([
      "# Thursday",
      "Notes from standup: ship the launch review by Friday.",
      `- [ ] ${task}`,
      "  - under $300 %%agent:thr_old%%",
    ]);
    await t.waitForStatus(task, ["working", "done"]);
    const digest = t.digests()[0]!;
    expect(digest).toContain(
      "Note (the whole file; line numbers as edit_note and anchor_line take them):",
    );
    expect(digest).toContain("1| # Thursday");
    expect(digest).toContain("2| Notes from standup: ship the launch review by Friday.");
    expect(digest).toMatch(/3\| - \[ \] Research espresso grinders {2}⟪tsk_\w+ · triaging⟫/);
    expect(digest).toContain("4|   - under $300  ⟪yours⟫");
  });
});
