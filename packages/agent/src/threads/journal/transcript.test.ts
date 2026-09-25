import type { PersistedJournalEvent, PersistedJournalPayload } from "@ddl/contract";
import { describe, expect, it } from "vitest";
import { renderTranscript } from "../../harness/transcript";
import {
  buildTranscript,
  INTERRUPTED_RESULT,
  UNCERTAIN_RESULT,
  UNDECIDED_RESULT,
} from "./transcript";

function journal(...payloads: PersistedJournalPayload[]): PersistedJournalEvent[] {
  return payloads.map(
    (payload, i) =>
      ({ v: 1, id: `evt_${i}`, epoch: 0, seq: i + 1, at: i, ...payload }) as PersistedJournalEvent,
  );
}

const S = "thr_a";
const prompt = (text: string, session = S): PersistedJournalPayload => ({
  type: "run.prompted",
  session,
  text,
});
const said = (text: string, session = S): PersistedJournalPayload => ({
  type: "run.text",
  session,
  text,
});
const call = (
  id: string,
  tool: string,
  input: unknown = {},
  session = S,
): PersistedJournalPayload => ({
  type: "tool.requested",
  call: id,
  tool,
  session,
  input,
});
const allowed = (id: string, effectful = true): PersistedJournalPayload[] => [
  { type: "tool.decided", call: id, allowed: true },
  {
    type: "tool.started",
    call: id,
    tool: "x",
    target: "x",
    ...(effectful ? {} : { effectful: false }),
  },
];
const done = (
  id: string,
  output: string,
  outcome: "ok" | "error" | "blocked" = "ok",
): PersistedJournalPayload => ({
  type: "tool.finished",
  call: id,
  outcome,
  output,
});

describe("buildTranscript", () => {
  it("rebuilds prompts, text, tool calls and results in conversation order", () => {
    const events = journal(
      {
        type: "thread.created",
        thread: { id: S, taskId: null, notePath: null, title: "t", status: "idle", createdAt: 0 },
      },
      prompt("Task: research desks"),
      said("Looking into it."),
      call("c1", "web_search", { query: "desks" }),
      ...allowed("c1", false),
      done("c1", "3 results"),
      call("c2", "web_fetch", { url: "https://a.example" }),
      call("c3", "web_fetch", { url: "https://b.example" }),
      ...allowed("c2", false),
      ...allowed("c3", false),
      done("c3", "page b"),
      done("c2", "page a"),
      prompt("The user replied in the thread: cheaper please"),
      said("Noted."),
    );
    expect(buildTranscript(events)).toEqual({
      sessionId: S,
      entries: [
        { role: "user", text: "Task: research desks" },
        {
          role: "assistant",
          text: "Looking into it.",
          toolCalls: [{ id: "c1", name: "web_search", input: { query: "desks" } }],
        },
        {
          role: "tool",
          toolCallId: "c1",
          toolName: "web_search",
          output: "3 results",
          isError: false,
        },
        {
          role: "assistant",
          text: "",
          toolCalls: [
            { id: "c2", name: "web_fetch", input: { url: "https://a.example" } },
            { id: "c3", name: "web_fetch", input: { url: "https://b.example" } },
          ],
        },
        { role: "tool", toolCallId: "c2", toolName: "web_fetch", output: "page a", isError: false },
        { role: "tool", toolCallId: "c3", toolName: "web_fetch", output: "page b", isError: false },
        { role: "user", text: "The user replied in the thread: cheaper please" },
        { role: "assistant", text: "Noted.", toolCalls: [] },
      ],
    });
  });

  it("says why a call has no result: cut off, uncertain, blocked or never decided", () => {
    const events = journal(
      prompt("Task: book it"),
      call("read", "browser_snapshot"),
      ...allowed("read", false),
      call("send", "slack_send"),
      ...allowed("send", true),
      call("denied", "browser_click"),
      { type: "tool.decided", call: "denied", allowed: false, reason: "User denied" },
      call("waiting", "mock_irreversible_action"),
    );
    const results = buildTranscript(events)!.entries.filter((e) => e.role === "tool");
    expect(results.map((r) => r.role === "tool" && [r.toolCallId, r.output, r.isError])).toEqual([
      ["read", INTERRUPTED_RESULT, true],
      ["send", UNCERTAIN_RESULT, true],
      ["denied", "Blocked by safety policy: User denied", true],
      ["waiting", UNDECIDED_RESULT, true],
    ]);
  });

  it("keeps failures and blocks as the model read them", () => {
    const events = journal(
      prompt("Task: x"),
      call("c1", "bash"),
      ...allowed("c1"),
      done("c1", "Error: exit 1", "error"),
      call("c2", "slack_send"),
      { type: "tool.decided", call: "c2", allowed: false, reason: "No" },
      done("c2", "Blocked by safety policy: No", "blocked"),
    );
    const results = buildTranscript(events)!.entries.filter((e) => e.role === "tool");
    expect(results).toMatchObject([
      { toolCallId: "c1", output: "Error: exit 1", isError: true },
      { toolCallId: "c2", output: "Blocked by safety policy: No", isError: true },
    ]);
  });

  it("is the latest session's conversation, including everything since it started", () => {
    const events = journal(
      prompt("Task: first attempt", "sess_old"),
      said("old text", "sess_old"),
      prompt("Task: retry", "sess_new"),
      said("new text", "sess_new"),
      call("c9", "web_search", {}, "sess_new"),
      prompt("The agent restarted…", "sess_new"),
    );
    const transcript = buildTranscript(events)!;
    expect(transcript.sessionId).toBe("sess_new");
    expect(transcript.entries.map((e) => e.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(transcript.entries[0]).toEqual({ role: "user", text: "Task: retry" });
  });

  it("is null for a journal without prompts (a thread no agent worked in)", () => {
    expect(buildTranscript(journal(said("hi")))).toBeNull();
  });
});

describe("renderTranscript", () => {
  it("writes the conversation as text, shortening long results and keeping the recent part", () => {
    const text = renderTranscript([
      { role: "user", text: "Task: x" },
      {
        role: "assistant",
        text: "On it",
        toolCalls: [{ id: "c1", name: "web_search", input: { q: "x" } }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        toolName: "web_search",
        output: "r".repeat(5_000),
        isError: false,
      },
    ]);
    expect(text).toContain("[user]\nTask: x");
    expect(text).toContain('→ called web_search {"q":"x"}');
    expect(text).toMatch(/← web_search: r{1999}…/);
    const long = renderTranscript(
      Array.from({ length: 100 }, (_, i) => ({
        role: "user" as const,
        text: `${i} ${"x".repeat(1_000)}`,
      })),
    );
    expect(long.length).toBeLessThan(62_000);
    expect(long).toContain("(earlier parts left out)");
    expect(long).toContain("99 x");
  });
});
