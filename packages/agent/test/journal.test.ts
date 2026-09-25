/**
 * The journal through the real runtime: write-ahead around tool calls, what a restart finds (an
 * action that may or may not have happened is shown as interrupted and never re-run on its own),
 * and retrying it (the gate asks again).
 */
import { decodePersistedThreadJournal } from "@ddl/contract";
import { type ApprovalRequest, type ToolSpec, textResult } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentScript, ScriptContext } from "../src/harness/scripted";
import type { HarnessSessionOptions } from "../src/harness/types";
import { RECORDS_PATH } from "../src/orchestrator/records";
import { parseDigestItems } from "../src/prompts/orchestrator";
import { createSafetyEvaluator } from "../src/safety/evaluator";
import { createSafetyGate } from "../src/safety/gate";
import { threadJournalPath } from "../src/threads/store";
import { type Gate, gate } from "./helpers/fakes";
import { createTestRuntime, type TestRuntime, TODAY } from "./helpers/runtime";

const WAIT = { timeout: 4_000, interval: 5 };
const TASK = "Send the venue a thank-you note in Slack";
let active: TestRuntime[] = [];

afterEach(async () => {
  for (const t of active) await t.runtime.stop();
  active = [];
});

/** A Slack send the test can hold mid-flight; counts every time it actually runs. */
function slackSend() {
  const runs: unknown[] = [];
  let hold: Gate | null = null;
  const spec: ToolSpec = {
    name: "slack_send",
    label: "Send in Slack",
    description: "Send a Slack message",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    safety: { category: "communication", describe: () => "Press Send in Slack" },
    async execute(input) {
      runs.push(input);
      if (hold) await hold.promise;
      return textResult("Sent");
    },
  };
  return {
    spec,
    runs,
    holdNext() {
      hold = gate();
      return hold;
    },
  };
}

function delegate(capabilities: string[] = ["web"]): AgentScript {
  return async (ctx) => {
    for (const item of parseDigestItems(ctx.message)) {
      if (item.kind === "reply") continue;
      await ctx.callTool("spawn_subagent", { taskId: item.taskId, goal: item.text, capabilities });
    }
  };
}

/** Sends the note, then finishes. */
const sender: AgentScript = async (ctx) => {
  const sent = await ctx.callTool("slack_send", { text: "Thank you!" });
  await ctx.callTool("finish_task", {
    status: sent.blocked ? "needs_user" : "done",
    summary: sent.blocked ? "Not sent" : "Sent the note",
  });
};

async function runtime(
  storage: MemoryStorageProvider,
  send: ReturnType<typeof slackSend>,
  subagent: AgentScript,
) {
  const kickoffs: string[] = [];
  const t = await createTestRuntime({
    storage,
    scriptFor: (options: HarnessSessionOptions): AgentScript =>
      options.role === "orchestrator"
        ? delegate()
        : async (ctx: ScriptContext) => {
            kickoffs.push(ctx.message);
            await subagent(ctx);
          },
    overrides: {
      createSafetyGate,
      createSafetyEvaluator: () => createSafetyEvaluator({ policy: { llmJudge: false } }),
      createExecutionTools: () => [send.spec],
    },
  });
  active.push(t);
  return { t, kickoffs };
}

/** Records and the note's tracker state are saved with a debounce: "crash" once they're on disk. */
async function persisted(storage: MemoryStorageProvider, status: string): Promise<void> {
  await vi.waitFor(async () => {
    expect((await storage.read(RECORDS_PATH))?.content).toContain(`"${status}"`);
    expect(
      await storage.list({ prefix: ".daily-do-list/state/tasks", includeHidden: true }),
    ).not.toEqual([]);
  }, WAIT);
}

async function approveNext(t: TestRuntime): Promise<ApprovalRequest> {
  const approval = await vi.waitFor(() => {
    const pending = t.runtime.listApprovals({ status: "pending" })[0];
    if (!pending) throw new Error("no pending approval");
    return pending;
  }, WAIT);
  await t.runtime.decideApproval(approval.id, { decision: "approve" });
  return approval;
}

/** What survives a crash: exactly the files on disk right now. */
async function crashCopy(storage: MemoryStorageProvider): Promise<MemoryStorageProvider> {
  const files: Record<string, string> = {};
  for (const entry of await storage.list({ includeHidden: true })) {
    files[entry.path] = (await storage.read(entry.path))!.content;
  }
  return new MemoryStorageProvider({ initialFiles: files });
}

async function journalTypes(storage: MemoryStorageProvider, threadId: string) {
  const file = await storage.read(threadJournalPath(threadId));
  return file ? decodePersistedThreadJournal(file.content, threadId).events.map((e) => e.type) : [];
}

describe("write-ahead around tool calls", () => {
  it("an action that was running when the app died is shown as interrupted and never re-run", async () => {
    const send = slackSend();
    const hold = send.holdNext();
    const first = await runtime(new MemoryStorageProvider(), send, sender);
    await first.t.storage.write(TODAY, `- [ ] ${TASK}\n`);
    await approveNext(first.t);
    await vi.waitFor(() => expect(send.runs).toHaveLength(1), WAIT);
    const threadId = first.t.record(TASK)!.threadId!;
    // The write-ahead record was on disk before the send started.
    expect(await journalTypes(first.t.storage, threadId)).toContain("tool.started");
    await persisted(first.t.storage, "working");

    const disk = await crashCopy(first.t.storage);
    hold.open();
    await first.t.runtime.stop();

    const again = slackSend();
    const second = await runtime(disk, again, sender);
    const thread = second.t.runtime.getThread(threadId)!.thread;
    const row = thread.messages.find((m) => m.kind === "tool_call" && m.toolName === "slack_send");
    expect(row).toMatchObject({
      status: "error",
      resultPreview: "Interrupted: it may or may not have happened",
    });
    expect(
      thread.messages.filter(
        (m) => m.kind === "text" && m.role === "system" && m.text.startsWith("Interrupted during:"),
      ),
    ).toMatchObject([
      {
        text: "Interrupted during: Press Send in Slack. It may or may not have happened, and it won't run again on its own.",
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(again.runs).toEqual([]);
    expect(second.kickoffs).toEqual([]);
    await second.t.runtime.stop();
    expect(await journalTypes(disk, threadId)).toContain("tool.interrupted");
  });

  it("an action that finished before the app died is not marked", async () => {
    const send = slackSend();
    const first = await runtime(new MemoryStorageProvider(), send, sender);
    await first.t.storage.write(TODAY, `- [ ] ${TASK}\n`);
    await approveNext(first.t);
    await first.t.waitForStatus(TASK, "done");
    const threadId = first.t.record(TASK)!.threadId!;
    await vi.waitFor(async () => {
      expect(await journalTypes(first.t.storage, threadId)).toContain("tool.finished");
    }, WAIT);
    await persisted(first.t.storage, "done");
    const disk = await crashCopy(first.t.storage);
    const second = await runtime(disk, slackSend(), sender);
    const thread = second.t.runtime.getThread(threadId)!.thread;
    expect(thread.messages.some((m) => m.kind === "text" && m.text.startsWith("Interrupted"))).toBe(
      false,
    );
    expect(await journalTypes(disk, threadId)).not.toContain("tool.interrupted");
  });

  it("retrying asks the gate again and tells the agent what may already have happened", async () => {
    const send = slackSend();
    const hold = send.holdNext();
    const first = await runtime(new MemoryStorageProvider(), send, sender);
    await first.t.storage.write(TODAY, `- [ ] ${TASK}\n`);
    await approveNext(first.t);
    await vi.waitFor(() => expect(send.runs).toHaveLength(1), WAIT);
    const threadId = first.t.record(TASK)!.threadId!;
    await persisted(first.t.storage, "working");
    const disk = await crashCopy(first.t.storage);
    hold.open();
    await first.t.runtime.stop();

    const again = slackSend();
    const second = await runtime(disk, again, sender);
    await second.t.runtime.retryThread(threadId);
    await vi.waitFor(() => expect(second.kickoffs).toHaveLength(1), WAIT);
    expect(second.kickoffs[0]).toContain(
      "The agent stopped while these steps were running, so they may or may not have happened:",
    );
    expect(second.kickoffs[0]).toContain('- "Press Send in Slack"');
    // The gate asks again: nothing about the journal lets the call through.
    expect(again.runs).toEqual([]);
    await approveNext(second.t);
    await second.t.waitForStatus(TASK, "done");
    expect(again.runs).toHaveLength(1);
  });
});
