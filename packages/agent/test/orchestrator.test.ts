import {
  type ArtifactMessage,
  type TextMessage,
  type ToolCallMessage,
  textResult,
} from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentScript, ScriptContext } from "../src/harness/scripted";
import type { HarnessSessionOptions } from "../src/harness/types";
import { parseDigestItems } from "../src/prompts/orchestrator";
import { type Gate, gate } from "./helpers/fakes";
import { createTestRuntime, isSubsequence, type TestRuntime, TODAY } from "./helpers/runtime";

const WAIT = { timeout: 4_000, interval: 5 };
let active: TestRuntime[] = [];

async function runtime(options: Parameters<typeof createTestRuntime>[0] = {}) {
  const t = await createTestRuntime(options);
  active.push(t);
  return t;
}

afterEach(async () => {
  for (const t of active) await t.runtime.stop();
  active = [];
});

function scripts(orchestrator: AgentScript, subagent: AgentScript) {
  return (options: HarnessSessionOptions): AgentScript =>
    options.role === "orchestrator" ? orchestrator : subagent;
}

/** Delegates every changed task in the digest. */
function delegateAll(capabilities: string[] = ["web"]): AgentScript {
  return async (ctx) => {
    for (const item of parseDigestItems(ctx.message)) {
      if (item.kind === "reply") continue;
      await ctx.callTool("spawn_subagent", { taskId: item.taskId, goal: item.text, capabilities });
    }
  };
}

function taskOf(ctx: ScriptContext): string {
  const match = /^Task: ("(?:[^"\\]|\\.)*")/m.exec(ctx.message);
  return match ? (JSON.parse(match[1]!) as string) : "";
}

function untilAborted(ctx: ScriptContext): Promise<void> {
  return new Promise((resolve) => {
    if (ctx.signal.aborted) resolve();
    ctx.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("orchestrator (default mock script)", () => {
  it("triages, delegates and completes a new task", async () => {
    const t = await runtime();
    const task = "Research standing desks under $500";
    await t.storage.write(TODAY, `- [ ] ${task}\n`);
    const record = await t.waitForStatus(task, "done");

    expect(isSubsequence(["triaging", "working", "done"], t.statusesOf(task))).toBe(true);
    expect(record.summary).toBe("Summary ready");
    const thread = t.thread(task);
    expect(thread.status).toBe("done");
    expect(thread.title).toBe(task);
    const texts = t.texts(task);
    expect(texts[0]).toBe("On it — research standing desks under $500.");
    expect(texts.some((s) => s.startsWith("Looking into"))).toBe(true);
    expect(texts.at(-1)).toContain("Here's a quick summary");
    expect(t.events.deltas.some((d) => d.threadId === thread.id)).toBe(true);

    const artifactMessage = thread.messages.find(
      (m): m is ArtifactMessage => m.kind === "artifact",
    );
    const artifact = await t.runtime.readArtifact(thread.id, artifactMessage!.artifactId);
    expect(artifact?.meta.kind).toBe("markdown");
    expect(new TextDecoder().decode(artifact!.body)).toContain(`# ${task}`);

    expect(record.unread).toBeGreaterThan(0);
    t.runtime.markThreadRead(thread.id);
    expect(t.record(task)?.unread).toBe(0);

    // Every tool call went through the gate with the right context.
    const subagentCalls = t.safety.log.calls.filter((c) => c.threadId === thread.id);
    expect(subagentCalls.map((c) => c.toolName)).toEqual([
      "post_update",
      "create_artifact",
      "finish_task",
    ]);
    expect(subagentCalls.every((c) => c.taskId === record.taskId)).toBe(true);
    const orchestratorCalls = t.safety.log.calls.filter((c) =>
      c.sessionId.startsWith("orchestrator:"),
    );
    expect(orchestratorCalls.map((c) => c.toolName)).toEqual(["post_comment", "spawn_subagent"]);
  });

  it("pauses for approval and continues once approved", async () => {
    const t = await runtime();
    const task = "Book dentist appointment next week";
    await t.storage.write(TODAY, `- [ ] ${task}\n`);
    const waiting = await t.waitForStatus(task, "waiting_approval");
    const thread = t.thread(task);
    const [approval] = t.runtime.listApprovals({ status: "pending" });
    expect(approval).toMatchObject({
      toolName: "mock_irreversible_action",
      categories: ["booking"],
      taskId: waiting.taskId,
      threadId: thread.id,
    });
    expect(
      thread.messages.some((m) => m.kind === "approval" && m.approvalId === approval!.id),
    ).toBe(true);
    expect(t.runtime.status().pendingApprovals).toBe(1);
    expect(t.runtime.getThread(thread.id)?.approvals.map((a) => a.id)).toEqual([approval!.id]);

    await t.runtime.decideApproval(approval!.id, { decision: "approve" });
    const done = await t.waitForStatus(task, "done");
    expect(done.summary).toBe("Booked (mock)");
    const tool = t.thread(task).messages.find((m): m is ToolCallMessage => m.kind === "tool_call");
    expect(tool).toMatchObject({ toolName: "mock_irreversible_action", status: "ok" });
    expect(t.events.approvals.map((a) => a.status)).toEqual(["pending", "approved"]);
  });

  it("reports a denied action as blocked and stops", async () => {
    const t = await runtime();
    const task = "Email landlord about the leaky faucet";
    await t.storage.write(TODAY, `- [ ] ${task}\n`);
    await t.waitForStatus(task, "waiting_approval");
    const [approval] = t.runtime.listApprovals({ status: "pending" });
    await t.runtime.decideApproval(approval!.id, { decision: "deny", note: "Not now" });
    const record = await t.waitForStatus(task, "waiting_user");
    expect(record.summary).toBe("Not approved");
    const tool = t.thread(task).messages.find((m): m is ToolCallMessage => m.kind === "tool_call");
    expect(tool?.status).toBe("blocked");
    expect(t.texts(task).at(-1)).toContain("wasn't approved");
  });

  it("silently ignores tasks with nothing digital to do", async () => {
    const t = await runtime();
    await t.storage.write(TODAY, "- [ ] Go to the gym\n");
    const record = await t.waitForStatus("Go to the gym", "ignored");
    expect(record.threadId).toBeNull();
    expect(t.runtime.listThreads()).toEqual([]);
  });

  it("cancels pending approvals and work when the task is checked off", async () => {
    const t = await runtime();
    const task = "Order new running shoes";
    await t.storage.write(TODAY, `- [ ] ${task}\n`);
    await t.waitForStatus(task, "waiting_approval");
    await t.storage.write(TODAY, `- [x] ${task}\n`);
    const record = await t.waitForStatus(task, "cancelled");
    expect(t.runtime.listApprovals({ status: "pending" })).toEqual([]);
    expect(t.events.approvals.at(-1)?.status).toBe("cancelled");
    expect(t.runtime.getThread(record.threadId!)?.thread.status).toBe("cancelled");
    expect(t.runtime.status()).toMatchObject({ running: 0, pendingApprovals: 0 });
  });
});

describe("orchestrator control plane", () => {
  it("cancels the subagent when its task is deleted", async () => {
    const aborted: string[] = [];
    const t = await runtime({
      scriptFor: scripts(delegateAll(), async (ctx) => {
        await ctx.say("Working on it");
        await untilAborted(ctx);
        aborted.push(taskOf(ctx));
      }),
    });
    await t.storage.write(TODAY, "- [ ] Plan anniversary trip to Kyoto\n- [ ] Renew passport\n");
    const record = await t.waitForStatus("Plan anniversary trip to Kyoto", "working");
    await t.storage.write(TODAY, "- [ ] Renew passport\n");
    await vi.waitFor(
      () => expect(t.runtime.getThread(record.threadId!)?.thread.status).toBe("cancelled"),
      WAIT,
    );
    expect(aborted).toContain("Plan anniversary trip to Kyoto");
    expect(t.record("Plan anniversary trip to Kyoto")).toBeUndefined();
    expect(t.record("Renew passport")?.status).toBe("working");
    const bubble = t.runtime
      .getThread(record.threadId!)
      ?.thread.messages.find((m): m is TextMessage => m.kind === "text");
    expect(bubble?.streaming).toBeFalsy();
  });

  it("steers a running subagent with the user's reply", async () => {
    const release = gate();
    const t = await runtime({
      scriptFor: scripts(delegateAll(), async (ctx) => {
        if (ctx.turn === 0) {
          await ctx.callTool("post_update", { text: "Comparing options", summary: "Comparing" });
          await release.promise;
          return;
        }
        await ctx.say(`Adjusting: ${ctx.message}`);
        await ctx.callTool("finish_task", {
          status: "done",
          summary: "Adjusted",
          shortSummary: "Adjusted",
        });
      }),
    });
    const task = "Research best standing desks";
    await t.storage.write(TODAY, `- [ ] ${task}\n`);
    await vi.waitFor(() => expect(t.record(task)?.summary).toBe("Comparing"), WAIT);
    await t.runtime.postUserMessage(t.thread(task).id, "Keep it under $300");
    release.open();
    await t.waitForStatus(task, "done");
    const texts = t.texts(task);
    expect(texts).toContain("Keep it under $300");
    expect(texts.some((s) => s.startsWith("Adjusting:") && s.includes("Keep it under $300"))).toBe(
      true,
    );
  });

  it("forwards edits of a task to its running subagent", async () => {
    const release = gate();
    const seen: string[] = [];
    const t = await runtime({
      scriptFor: scripts(delegateAll(), async (ctx) => {
        seen.push(ctx.message);
        if (ctx.turn === 0) await release.promise;
        await ctx.callTool("finish_task", { status: "done", summary: "ok" });
      }),
    });
    await t.storage.write(TODAY, "- [ ] Find a plumber\n");
    await t.waitForStatus("Find a plumber", "working");
    await t.storage.write(TODAY, "- [ ] Find a plumber for Saturday\n");
    // Let the edit settle (settleMs is 20ms in tests) while the subagent is still running.
    await new Promise((resolve) => setTimeout(resolve, 150));
    release.open();
    await t.waitForStatus("Find a plumber for Saturday", "done");
    expect(seen.some((m) => m.includes("The user edited the task") && m.includes("Saturday"))).toBe(
      true,
    );
  });

  it("queues subagents beyond maxConcurrentSubagents", async () => {
    const gates = new Map<string, Gate>();
    const t = await runtime({
      settings: { agent: { maxConcurrentSubagents: 1 } },
      scriptFor: scripts(delegateAll(), async (ctx) => {
        const g = gate();
        gates.set(taskOf(ctx), g);
        await g.promise;
        await ctx.callTool("finish_task", { status: "done", summary: "ok", shortSummary: "ok" });
      }),
    });
    await t.storage.write(TODAY, "- [ ] Task one alpha\n- [ ] Task two beta\n");
    await t.waitForStatus("Task one alpha", "working");
    await t.waitForStatus("Task two beta", "queued");
    expect(t.runtime.status()).toMatchObject({ running: 1, queued: 1 });
    await vi.waitFor(() => expect(gates.has("Task one alpha")).toBe(true), WAIT);
    gates.get("Task one alpha")!.open();
    await t.waitForStatus("Task one alpha", "done");
    await t.waitForStatus("Task two beta", "working");
    await vi.waitFor(() => expect(gates.has("Task two beta")).toBe(true), WAIT);
    gates.get("Task two beta")!.open();
    await t.waitForStatus("Task two beta", "done");
    expect(t.statusesOf("Task two beta")).toContain("queued");
  });

  it("routes a reply to the orchestrator when no subagent exists", async () => {
    const kickoffs: string[] = [];
    const orchestrator: AgentScript = async (ctx) => {
      for (const item of parseDigestItems(ctx.message)) {
        if (item.kind === "reply") {
          await ctx.callTool("spawn_subagent", {
            taskId: item.taskId,
            goal: `Handle: ${item.text}`,
            capabilities: ["web"],
          });
        } else {
          await ctx.callTool("ask_user", {
            taskId: item.taskId,
            question: "Which thing do you mean?",
          });
        }
      }
    };
    const t = await runtime({
      scriptFor: scripts(orchestrator, async (ctx) => {
        kickoffs.push(ctx.message);
        await ctx.callTool("finish_task", {
          status: "done",
          summary: "Handled",
          shortSummary: "Handled",
        });
      }),
    });
    const task = "Figure out the thing";
    await t.storage.write(TODAY, `- [ ] ${task}\n`);
    await t.waitForStatus(task, "waiting_user");
    expect(t.texts(task)).toContain("Which thing do you mean?");
    await t.runtime.postUserMessage(t.thread(task).id, "the tax form");
    await t.waitForStatus(task, "done");
    expect(kickoffs[0]).toContain("Goal: Handle: the tax form");
    expect(kickoffs[0]).toContain("History of this task's thread");
  });

  it("marks tasks failed when the orchestrator errors and recovers on retry", async () => {
    let fail = true;
    const orchestrator: AgentScript = async (ctx) => {
      if (fail) throw new Error("model unavailable");
      for (const item of parseDigestItems(ctx.message)) {
        await ctx.callTool("set_task_status", { taskId: item.taskId, status: "ignored" });
      }
    };
    const t = await runtime({ scriptFor: scripts(orchestrator, async () => {}) });
    await t.storage.write(TODAY, "- [ ] Renew passport\n");
    const failed = await t.waitForStatus("Renew passport", "failed");
    expect(failed.summary).toBe("Couldn't triage");
    expect(t.runtime.status().problem).toContain("model unavailable");
    expect(
      t.thread("Renew passport").messages.some((m) => m.kind === "status" && m.status === "failed"),
    ).toBe(true);

    fail = false;
    await t.runtime.retryThread(failed.threadId!);
    await t.waitForStatus("Renew passport", "ignored");
    await vi.waitFor(() => expect(t.runtime.status().problem).toBeUndefined(), WAIT);
  });

  it("fails tasks of an orchestrator turn that hangs past the timeout", async () => {
    let calls = 0;
    const t = await runtime({
      overrides: { turnTimeoutMs: 100 },
      scriptFor: scripts(
        async (ctx) => {
          calls++;
          if (calls === 1) return untilAborted(ctx);
          for (const item of parseDigestItems(ctx.message)) {
            await ctx.callTool("set_task_status", { taskId: item.taskId, status: "ignored" });
          }
        },
        async () => {},
      ),
    });
    await t.storage.write(TODAY, "- [ ] Water the garden beds\n");
    const failed = await t.waitForStatus("Water the garden beds", "failed");
    expect(t.runtime.status().problem).toContain("took too long");
    await t.runtime.retryThread(failed.threadId!);
    await t.waitForStatus("Water the garden beds", "ignored");
  });

  it("answers replies on deleted tasks without involving the agents", async () => {
    const t = await runtime({
      scriptFor: scripts(
        async (ctx) => {
          for (const item of parseDigestItems(ctx.message)) {
            await ctx.callTool("post_comment", { taskId: item.taskId, text: "Canberra." });
          }
        },
        async () => {},
      ),
    });
    await t.storage.write(TODAY, "- [ ] What's the capital of Australia?\n- [ ] Pay rent\n");
    const done = await t.waitForStatus("What's the capital of Australia?", "done");
    await t.storage.write(TODAY, "- [ ] Pay rent\n");
    await vi.waitFor(
      () => expect(t.record("What's the capital of Australia?")).toBeUndefined(),
      WAIT,
    );
    await t.runtime.postUserMessage(done.threadId!, "Thanks!");
    const texts = t.runtime
      .getThread(done.threadId!)!
      .thread.messages.filter((m): m is TextMessage => m.kind === "text")
      .map((m) => m.text);
    expect(texts.at(-1)).toContain("no longer in your notes");
  });

  it("gives nested tasks their parent's text as context", async () => {
    const digests: string[] = [];
    const t = await runtime({
      scriptFor: scripts(
        async (ctx) => {
          digests.push(ctx.message);
          for (const item of parseDigestItems(ctx.message)) {
            await ctx.callTool("set_task_status", { taskId: item.taskId, status: "ignored" });
          }
        },
        async () => {},
      ),
    });
    await t.storage.write(TODAY, "- [ ] Plan Kyoto trip\n  - [ ] Book flights\n");
    await t.waitForStatus("Book flights", "ignored");
    expect(digests.join("\n")).toContain('"Book flights" (subtask of "Plan Kyoto trip")');
  });

  it("retries a failed subagent in a fresh session primed with the thread history", async () => {
    const runs: Array<{ sessionId: string; message: string }> = [];
    const t = await runtime({
      scriptFor: scripts(delegateAll(), async (ctx) => {
        runs.push({ sessionId: ctx.sessionId, message: ctx.message });
        if (runs.length === 1) {
          await ctx.callTool("post_update", { text: "Found 3 flights so far" });
          throw new Error("browser crashed");
        }
        await ctx.callTool("finish_task", {
          status: "done",
          summary: "Compared",
          shortSummary: "Compared",
        });
      }),
    });
    const task = "Compare flights to Denver";
    await t.storage.write(TODAY, `- [ ] ${task}\n`);
    const failed = await t.waitForStatus(task, "failed");
    expect(failed.summary).toContain("browser crashed");

    await t.runtime.retryThread(failed.threadId!);
    await t.waitForStatus(task, "done");
    expect(runs).toHaveLength(2);
    expect(runs[1]!.sessionId).not.toBe(runs[0]!.sessionId);
    expect(runs[1]!.message).toContain("This is a retry");
    expect(runs[1]!.message).toContain("Found 3 flights so far");
  });

  it("forwards surface frames only while someone is subscribed", async () => {
    const steps = [gate(), gate()];
    const t = await runtime({
      overrides: {
        createExecutionTools: (_provider, ctx) => [
          {
            name: "browser_navigate",
            label: "Open page",
            description: "Navigate",
            parameters: { type: "object", properties: {} },
            safety: { readOnly: true, category: "read" },
            async execute() {
              ctx.onFrame?.("browser", {
                mimeType: "image/jpeg",
                data: "AAAA",
                width: 4,
                height: 4,
                ts: Date.now(),
              });
              return textResult("ok");
            },
          },
        ],
      },
      scriptFor: scripts(delegateAll(), async (ctx) => {
        await ctx.callTool("browser_navigate", {});
        await steps[0]!.promise;
        await ctx.callTool("browser_navigate", {});
        await steps[1]!.promise;
        await ctx.callTool("browser_navigate", {});
        await ctx.callTool("finish_task", { status: "done", summary: "ok" });
      }),
    });
    const task = "Check the museum opening hours";
    await t.storage.write(TODAY, `- [ ] ${task}\n`);
    await vi.waitFor(() => expect(t.thread(task).surfaces).toEqual(["browser"]), WAIT);
    expect(t.events.frames).toHaveLength(0);
    const unsubscribe = t.runtime.subscribeSurface(t.thread(task).id, "browser");
    steps[0]!.open();
    await vi.waitFor(() => expect(t.events.frames).toHaveLength(1), WAIT);
    expect(t.events.frames[0]).toMatchObject({ threadId: t.thread(task).id, surface: "browser" });
    unsubscribe();
    steps[1]!.open();
    await t.waitForStatus(task, "done");
    expect(t.events.frames).toHaveLength(1);
    const tool = t.thread(task).messages.find((m): m is ToolCallMessage => m.kind === "tool_call");
    expect(tool).toMatchObject({ toolName: "browser_navigate", label: "Open page", status: "ok" });
  });
});

describe("restarts", () => {
  it("re-triages tasks whose triage was interrupted by a stop", async () => {
    const storage = new MemoryStorageProvider();
    const first = await createTestRuntime({
      storage,
      scriptFor: scripts(
        async (ctx) => untilAborted(ctx),
        async () => {},
      ),
    });
    const task = "Research ergonomic chairs";
    await first.storage.write(TODAY, `- [ ] ${task}\n`);
    await first.waitForStatus(task, "triaging");
    await first.runtime.stop();
    expect(first.record(task)?.status).toBe("triaging");

    const second = await runtime({ storage });
    await second.waitForStatus(task, "done");
  });

  it("marks interrupted work as failed and lets the user retry it", async () => {
    const storage = new MemoryStorageProvider();
    const first = await createTestRuntime({
      storage,
      scriptFor: scripts(delegateAll(), async (ctx) => untilAborted(ctx)),
    });
    const task = "Draft the quarterly newsletter";
    await first.storage.write(TODAY, `- [ ] ${task}\n`);
    await first.waitForStatus(task, "working");
    await first.runtime.stop();
    expect(first.record(task)).toMatchObject({ status: "failed", summary: "Interrupted" });

    const second = await runtime({ storage });
    const record = second.record(task);
    expect(record).toMatchObject({ status: "failed", summary: "Interrupted" });
    await second.runtime.retryThread(record!.threadId!);
    await second.waitForStatus(task, "done");
  });

  it("recovers records left active by a crash", async () => {
    const storage = new MemoryStorageProvider();
    const first = await createTestRuntime({
      storage,
      scriptFor: scripts(delegateAll(), async (ctx) => untilAborted(ctx)),
    });
    const task = "Summarize the lease agreement";
    await first.storage.write(TODAY, `- [ ] ${task}\n`);
    await first.waitForStatus(task, "working");
    const persisted = await vi.waitFor(async () => {
      const file = await storage.read(".daily-do-list/state/records.json");
      expect(file?.content).toContain('"working"');
      return file!.content;
    }, WAIT);
    // Simulate a crash: abandon the first runtime without stopping it.
    const crashed = new MemoryStorageProvider({
      initialFiles: Object.fromEntries(
        await Promise.all(
          (await storage.list({ includeHidden: true })).map(async (e) => [
            e.path,
            e.path === ".daily-do-list/state/records.json"
              ? persisted
              : (await storage.read(e.path))!.content,
          ]),
        ),
      ),
    });
    await first.runtime.stop();
    const second = await runtime({ storage: crashed });
    expect(second.record(task)).toMatchObject({ status: "failed", summary: "Interrupted" });
  });
});
