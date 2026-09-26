import { ORCHESTRATOR_THREAD_ID, textResult } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { describe, expect, it } from "vitest";
import { createThreadStore, threadJournalPath } from "../threads/store";
import { OrchestratorChat } from "./chat";

function setup(options: { maxMessages?: number } = {}) {
  let clock = 1_790_000_000_000;
  const storage = new MemoryStorageProvider();
  const threads = createThreadStore({ storage, now: () => clock, flushDelayMs: 1 });
  const chat = new OrchestratorChat({ threads, now: () => clock, ...options });
  return {
    storage,
    threads,
    chat,
    tick: (ms: number) => {
      clock += ms;
    },
    messages: () => threads.get(ORCHESTRATOR_THREAD_ID)!.messages,
  };
}

const LABELS = new Map([["set_task_status", "Set task status"]]);

describe("OrchestratorChat", () => {
  it("shows thinking as one line per turn with its total time, never the thoughts", async () => {
    const s = setup();
    s.chat.beginTurn("Daily/2026-09-24.md changed: 1 task", LABELS);
    s.chat.onEvent({ type: "thinking_delta", messageId: "m1", delta: "The user wants " });
    expect(s.messages().at(-1)).toMatchObject({ kind: "status", text: "Thinking…" });
    s.tick(2_400);
    s.chat.onEvent({ type: "thinking_delta", messageId: "m1", delta: "a secret plan" });
    s.chat.onEvent({
      type: "tool_start",
      toolCallId: "c1",
      toolName: "set_task_status",
      input: { taskId: "tsk_a", status: "ignored" },
    });
    s.chat.onEvent({
      type: "tool_end",
      toolCallId: "c1",
      toolName: "set_task_status",
      result: textResult("Status set to ignored."),
      isError: false,
    });
    s.chat.onEvent({ type: "thinking_delta", messageId: "m2", delta: "Done." });
    s.tick(1_100);
    s.chat.onEvent({ type: "message_end", messageId: "m2", text: "" });
    s.chat.endTurn();

    const messages = s.messages();
    expect(messages.map((m) => [m.kind, m.author])).toEqual([
      ["status", "system"],
      ["status", "orchestrator"],
      ["tool_call", "orchestrator"],
    ]);
    expect(messages[1]).toMatchObject({ status: "working", text: "Thought for 4 s" });
    expect(messages[2]).toMatchObject({
      label: "Set task status",
      input: { taskId: "tsk_a", status: "ignored" },
      status: "ok",
      resultPreview: "Status set to ignored.",
    });
    await s.threads.flush();
    const file = (await s.storage.read(threadJournalPath(ORCHESTRATOR_THREAD_ID)))!.content;
    expect(file).not.toContain("secret");
    expect(file).not.toContain("The user wants");
  });

  it("is working during a turn and idle after it, even when it failed or was stopped", () => {
    const s = setup();
    s.chat.ensure();
    const statuses: string[] = [];
    s.threads.on((event) => {
      if (event.type === "thread.upsert" && statuses.at(-1) !== event.thread.status) {
        statuses.push(event.thread.status);
      }
    });
    s.chat.beginTurn("You wrote to me", LABELS);
    s.chat.endTurn({ error: "The model is unavailable" });
    s.chat.beginTurn("You wrote to me", LABELS);
    s.chat.onEvent({ type: "text_delta", messageId: "m1", delta: "Let me" });
    s.chat.endTurn({ cancelled: true });
    expect(statuses).toEqual(["idle", "working", "idle", "working", "idle"]);
    expect(s.threads.get(ORCHESTRATOR_THREAD_ID)!.status).toBe("idle");
    expect(
      s.messages().map((m) => (m.kind === "status" ? `${m.status}: ${m.text}` : m.kind)),
    ).toEqual([
      "working: You wrote to me",
      "failed: This run failed: The model is unavailable",
      "working: You wrote to me",
      "text",
      "cancelled: You stopped this run",
    ]);
    expect(s.messages()[3]).toMatchObject({ text: "Let me", author: "orchestrator" });
    expect(s.messages()[3]).not.toHaveProperty("streaming");
  });

  it("keeps the newest messages only, in memory and on disk", async () => {
    const s = setup({ maxMessages: 5 });
    for (let turn = 1; turn <= 3; turn++) {
      s.chat.beginTurn(`Turn ${turn}`, LABELS);
      s.chat.onEvent({ type: "message_end", messageId: `a${turn}`, text: `Reply ${turn}.` });
      s.chat.onEvent({ type: "message_end", messageId: `b${turn}`, text: `More ${turn}.` });
      s.chat.endTurn();
    }
    expect(s.messages()).toHaveLength(5);
    expect(s.messages().map((m) => (m.kind === "text" ? m.text : `[${m.kind}]`))).toEqual([
      "Reply 2.",
      "More 2.",
      "[status]",
      "Reply 3.",
      "More 3.",
    ]);
    await s.threads.flush();
    const reloaded = createThreadStore({ storage: s.storage });
    await reloaded.load();
    expect(reloaded.get(ORCHESTRATOR_THREAD_ID)!.messages).toHaveLength(5);
  });

  it("settles a turn a crashed daemon left open", () => {
    const s = setup();
    s.chat.beginTurn("You wrote to me", LABELS);
    s.chat.onEvent({
      type: "tool_start",
      toolCallId: "c1",
      toolName: "set_task_status",
      input: {},
    });
    const restarted = new OrchestratorChat({ threads: s.threads });
    restarted.ensure();
    expect(s.threads.get(ORCHESTRATOR_THREAD_ID)!.status).toBe("idle");
    expect(s.messages().at(-1)).toMatchObject({ status: "error", resultPreview: "Interrupted" });
  });

  it("lists the recent exchanges with the user, oldest first", () => {
    const s = setup();
    s.chat.ensure();
    const post = (id: string, role: "user" | "agent" | "system", text: string) =>
      s.threads.upsertMessage(ORCHESTRATOR_THREAD_ID, {
        id,
        kind: "text",
        role,
        author: role === "user" ? "you" : role === "agent" ? "orchestrator" : "system",
        text,
        createdAt: 1,
      });
    post("m1", "user", "What are you working on?");
    post("m2", "agent", "Two things.");
    post("m3", "system", "The agent isn't running.");
    post("m4", "user", "Drop the first");
    post("m5", "user", "Now");
    expect(s.chat.recentExchanges(3, new Set(["m5"]))).toEqual([
      { author: "you", text: "What are you working on?", createdAt: 1 },
      { author: "orchestrator", text: "Two things.", createdAt: 1 },
      { author: "you", text: "Drop the first", createdAt: 1 },
    ]);
  });
});
