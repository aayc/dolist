/**
 * The orchestrator's own chat: every turn recorded (what woke it, its streamed text, its tool calls
 * with the task they act on, running → idle), and the user writing to it directly — answered in the
 * chat, acted on through the safety gate, remembered across sessions and restarts, and stoppable.
 */
import {
  ORCHESTRATOR_THREAD_ID,
  type StatusMessage,
  type TextMessage,
  type ThreadMessage,
  type ToolCallMessage,
} from "@ddl/core";
import { describe, expect, it } from "vitest";
import type { FakeAgentRuntime } from "../../src/testing";
import { expectAllGated, fakeRuntime, subagentFor, useFakeRuntimes } from "./helpers";

useFakeRuntimes();

const DESKS = "Research best standing desks under $500";
const GYM = "Go to the gym";

function statusLines(messages: readonly ThreadMessage[], author = "system"): string[] {
  return messages
    .filter((m): m is StatusMessage => m.kind === "status" && m.author === author)
    .map((m) => m.text ?? "");
}

function replies(t: FakeAgentRuntime): string[] {
  return t
    .chat()
    .messages.filter(
      (m): m is TextMessage =>
        m.kind === "text" && m.role === "agent" && m.author === "orchestrator",
    )
    .map((m) => m.text);
}

function toolCalls(t: FakeAgentRuntime): ToolCallMessage[] {
  return t.chat().messages.filter((m): m is ToolCallMessage => m.kind === "tool_call");
}

/** Statuses the chat went through, from `thread.upsert` events. */
function chatStatuses(t: FakeAgentRuntime): string[] {
  const out: string[] = [];
  for (const event of t.events) {
    if (event.type !== "thread.upsert" || event.payload.id !== ORCHESTRATOR_THREAD_ID) continue;
    if (out.at(-1) !== event.payload.status) out.push(event.payload.status);
  }
  return out;
}

async function waitForReply(t: FakeAgentRuntime, count = 1): Promise<string> {
  return t.waitFor(
    () => (t.chat().status === "idle" && replies(t).length >= count ? replies(t).at(-1) : null),
    { what: `reply ${count} in the orchestrator's chat` },
  );
}

describe("the orchestrator's chat records its turns", () => {
  it("exists from the start, empty and idle", async () => {
    const t = await fakeRuntime();
    expect(t.chat()).toMatchObject({
      id: ORCHESTRATOR_THREAD_ID,
      taskId: null,
      notePath: null,
      title: "Orchestrator",
      status: "idle",
      messages: [],
    });
  });

  it("shows what woke it and each decision, with the task it acts on", async () => {
    const t = await fakeRuntime();
    const note = await t.writeDailyNote([`- [ ] ${DESKS}`, `- [ ] ${GYM}`]);
    await t.waitForStatus(GYM, "ignored");
    await t.waitForStatus(DESKS, "done");
    await t.waitFor(() => t.chat().status === "idle" && statusLines(t.chat().messages).length >= 2);

    const desks = t.record(DESKS)!.taskId;
    const gym = t.record(GYM)!.taskId;
    expect(statusLines(t.chat().messages)).toEqual([
      `${note} changed: 2 tasks`,
      `“${DESKS}” finished`,
    ]);
    const calls = toolCalls(t).map((m) => ({
      tool: m.toolName,
      label: m.label,
      taskId: (m.input as { taskId?: string }).taskId,
      status: m.status,
    }));
    expect(calls).toEqual([
      { tool: "post_comment", label: "Comment on task", taskId: desks, status: "ok" },
      { tool: "spawn_subagent", label: "Delegate to subagent", taskId: desks, status: "ok" },
      { tool: "set_task_status", label: "Set task status", taskId: gym, status: "ok" },
    ]);
    const spawn = toolCalls(t).find((m) => m.toolName === "spawn_subagent")!;
    expect(spawn.input).toMatchObject({ capabilities: ["web"] });
    expect(spawn.resultPreview).toBe(`Subagent started for ${desks}.`);
    expect(chatStatuses(t)).toEqual(["idle", "working", "idle", "working", "idle"]);
    expectAllGated(t);
  });
});

describe("writing to the orchestrator", () => {
  it("answers in its chat, streamed, from what it knows", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([`- [ ] ${DESKS}`]);
    await t.waitForStatus(DESKS, "done");
    await t.idle();

    await t.writeToOrchestrator("What are you working on?");
    const reply = await waitForReply(t);
    expect(reply).toBe("Nothing is running right now. Done today: 1.");
    const messages = t.chat().messages;
    const question = messages.findIndex((m) => m.kind === "text" && m.role === "user");
    expect(messages[question]).toMatchObject({ author: "you", text: "What are you working on?" });
    expect(statusLines(messages.slice(question))).toEqual(["You wrote to me"]);
    const answer = messages.find((m) => m.kind === "text" && m.author === "orchestrator")!;
    const streamed = t.events.filter(
      (e) => e.type === "thread.delta" && e.payload.messageId === answer.id,
    );
    expect(streamed.length).toBeGreaterThan(0);
    expect((answer as TextMessage).streaming).toBeUndefined();

    const digest = t.digests().at(-1)!;
    expect(digest).toContain(
      '## Messages to you (the user wrote in your chat; your turn\'s text is your reply)\n- [direct] "What are you working on?"',
    );
    // Today's list comes along, so "the dentist task" can be resolved.
    expect(digest).toContain(`- [ ] ${t.record(DESKS)!.taskId}: "${DESKS}" · agent: done`);
  });

  it("drops a task it's working on when asked: the subagent is cancelled through the gate", async () => {
    const t = await fakeRuntime();
    t.brain.hang({ role: subagentFor(DESKS) });
    await t.writeDailyNote([`- [ ] ${DESKS}`]);
    await t.waitFor(() => t.brain.decisions.some((d) => d.label === "hang"), {
      what: "the subagent to be mid-call",
    });

    await t.writeToOrchestrator("Drop the desk research, please");
    const reply = await waitForReply(t);
    expect(reply).toBe(`Dropped “${DESKS}” — I stopped its agent.`);
    await t.waitForStatus(DESKS, "cancelled");
    const cancel = toolCalls(t).find((m) => m.toolName === "cancel_subagent")!;
    expect(cancel).toMatchObject({ status: "ok", input: { taskId: t.record(DESKS)!.taskId } });
    const gated = t.audit.gate.find((g) => g.toolName === "cancel_subagent");
    expect(gated?.sessionId.startsWith("orchestrator:")).toBe(true);
    expect(gated?.decision).toEqual({ allow: true });
    expectAllGated(t);
  });

  it("drops a task nothing works on by ignoring it", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([`- [ ] ${DESKS}`]);
    await t.waitForStatus(DESKS, "done");
    await t.idle();
    await t.writeToOrchestrator("Forget about the standing desks");
    expect(await waitForReply(t)).toBe(`Dropped “${DESKS}”.`);
    expect(t.record(DESKS)).toMatchObject({ status: "ignored", summary: "Dropped" });
  });

  it("passes instructions on to the subagent at work", async () => {
    const t = await fakeRuntime();
    t.brain.hang({ role: subagentFor(DESKS) });
    await t.writeDailyNote([`- [ ] ${DESKS}`]);
    await t.waitFor(() => t.brain.decisions.some((d) => d.label === "hang"), {
      what: "the subagent to be mid-call",
    });
    await t.writeToOrchestrator("Also check prices at IKEA");
    expect(await waitForReply(t)).toBe(`Passed that on to the agent working on “${DESKS}”.`);
    expect(toolCalls(t).find((m) => m.toolName === "message_subagent")).toMatchObject({
      status: "ok",
      input: { taskId: t.record(DESKS)!.taskId, text: "The user adds: Also check prices at IKEA" },
    });
  });

  it("asks for approval in its chat before changing the user's note", async () => {
    const t = await fakeRuntime();
    await t.writeDailyNote([`- [ ] ${GYM}`]);
    await t.waitForStatus(GYM, "ignored");
    await t.idle();
    const gym = t.record(GYM)!.taskId;
    t.brain.when(
      (_request, info) =>
        info.role === "orchestrator" && info.lastUserText.includes('[direct] "Check off the gym"'),
      (request, info) => {
        if (info.callsSinceUser.length === 0) {
          return {
            toolCalls: [
              {
                name: "edit_note",
                arguments: {
                  taskId: gym,
                  edits: [{ op: "set_checkbox", taskId: gym, checked: true }],
                },
              },
            ],
          };
        }
        const said = request.messages.some((m) => m.role === "assistant" && m.content !== "");
        return said ? {} : { text: "Checked it off." };
      },
    );

    await t.writeToOrchestrator("Check off the gym");
    const approval = await t.waitForApproval();
    expect(approval).toMatchObject({
      threadId: ORCHESTRATOR_THREAD_ID,
      taskId: null,
      toolName: "edit_note",
    });
    expect(t.chat().status).toBe("working");
    expect(t.chat().messages).toContainEqual(
      expect.objectContaining({ kind: "approval", approvalId: approval.id }),
    );
    await t.approveNext();
    expect(await waitForReply(t)).toBe("Checked it off.");
    expect((await t.storage.read(t.notePath()))?.content).toContain(`- [x] ${GYM}`);
    expectAllGated(t);
  });

  it("keeps the recent exchanges in the digest, for the next message and a fresh session", async () => {
    const t = await fakeRuntime();
    await t.writeToOrchestrator("What are you working on?");
    await waitForReply(t);
    await t.writeToOrchestrator("Anything else?");
    await waitForReply(t, 2);
    expect(t.digests().at(-1)).toContain(
      '## Your recent chat with the user\n- [you, <1m ago] "What are you working on?"\n- [orchestrator, <1m ago] "Nothing is running right now. Write a task in today\'s note and I\'ll pick it up."',
    );
    expect(t.digests().at(-1)).not.toContain('[you, <1m ago] "Anything else?"');

    await t.restart();
    await t.writeDailyNote([`- [ ] ${GYM}`]);
    await t.waitForStatus(GYM, "ignored");
    const fresh = t.digests().at(-1)!;
    expect(fresh).toContain('- [you, <1m ago] "Anything else?"');
    expect(fresh).not.toContain("## Messages to you");
  });

  it("stops the turn in progress when asked; the next message gets a fresh start", async () => {
    const t = await fakeRuntime();
    t.brain.hang({ role: "orchestrator" });
    await t.writeToOrchestrator("What are you working on?");
    await t.waitFor(() => t.brain.decisions.some((d) => d.label === "hang"), {
      what: "the orchestrator to be mid-call",
    });
    expect(t.chat().status).toBe("working");

    await t.runtime.cancelThread(ORCHESTRATOR_THREAD_ID);
    await t.waitFor(() => t.chat().status === "idle", { what: "the chat to go idle" });
    expect(t.chat().messages.at(-1)).toMatchObject({
      kind: "status",
      status: "cancelled",
      text: "You stopped this run",
    });
    expect(t.runtime.status().problem).toBeUndefined();

    await t.writeToOrchestrator("What are you working on?");
    expect(await waitForReply(t)).toContain("Nothing is running right now.");
    // Stopping when nothing runs is a no-op.
    await t.runtime.cancelThread(ORCHESTRATOR_THREAD_ID);
    expect(t.chat().messages.at(-1)).toMatchObject({ kind: "text", author: "orchestrator" });
  });

  it("keeps the chat across restarts", async () => {
    const t = await fakeRuntime();
    await t.writeToOrchestrator("What are you working on?");
    const reply = await waitForReply(t);
    const before = t.chat().messages.map((m) => m.id);
    await t.restart();
    expect(t.chat().messages.map((m) => m.id)).toEqual(before);
    expect(replies(t)).toEqual([reply]);
    expect(t.chat().status).toBe("idle");
  });

  it("explains, and keeps the message, while the agent can't run", async () => {
    const t = await fakeRuntime({ mode: "off" });
    await t.writeToOrchestrator("Are you there?");
    expect(t.chat().messages.map((m) => (m.kind === "text" ? m.text : m.kind))).toEqual([
      "Are you there?",
      expect.stringMatching(/^The agent isn't running .*Your message is saved\.$/),
    ]);
  });
});
