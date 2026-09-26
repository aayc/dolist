import { type TextMessage, type ToolCallMessage, textResult, toolResultText } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentScript, ScriptContext } from "../src/harness/scripted";
import type { HarnessSessionOptions } from "../src/harness/types";
import { parseDigestItems } from "../src/prompts/orchestrator";
import { gate } from "./helpers/fakes";
import { createTestRuntime, type TestRuntime, TODAY } from "./helpers/runtime";

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

  it("searches and reads the user's other notes, beyond the daily note", async () => {
    const storage = new MemoryStorageProvider();
    await storage.write("Projects/Kyoto trip.md", "# Kyoto trip\n\nStay at a ryokan near Gion.\n");
    const turns: Array<{ tools: string[]; search: string; read: string }> = [];
    const t = await runtime({
      storage,
      scriptFor: scripts(
        async (ctx) => {
          const search = await ctx.callTool("search_notes", { query: "ryokan" });
          const read = await ctx.callTool("read_note", { path: "[[Kyoto trip]]" });
          turns.push({
            tools: ctx.tools.map((tool) => tool.name).sort(),
            search: toolResultText(search.result),
            read: toolResultText(read.result),
          });
          for (const item of parseDigestItems(ctx.message)) {
            await ctx.callTool("set_task_status", { taskId: item.taskId, status: "ignored" });
          }
        },
        async () => {},
      ),
    });
    await t.storage.write(TODAY, "- [ ] Plan the Kyoto trip\n");
    await t.waitForStatus("Plan the Kyoto trip", "ignored");

    const [turn] = turns;
    // web_search and web_fetch join these in live mode.
    expect(turn?.tools).toEqual([
      "anchor_line",
      "ask_user",
      "cancel_subagent",
      "create_routine",
      "edit_note",
      "list_routines",
      "list_tasks",
      "message_subagent",
      "post_comment",
      "read_drawing",
      "read_note",
      "run_routine",
      "search_notes",
      "set_task_status",
      "spawn_subagent",
      "update_routine",
    ]);
    expect(turn?.search).toContain("Projects/Kyoto trip.md:3: Stay at a ryokan near Gion.");
    expect(turn?.read).toContain("# Projects/Kyoto trip.md");
    expect(turn?.read).toContain("Stay at a ryokan near Gion.");
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
  it("leaves work a stop interrupted as it was, and the next start picks it back up", async () => {
    const storage = new MemoryStorageProvider();
    const first = await createTestRuntime({
      storage,
      scriptFor: scripts(delegateAll(), async (ctx) => untilAborted(ctx)),
    });
    const task = "Draft the quarterly newsletter";
    await first.storage.write(TODAY, `- [ ] ${task}\n`);
    await first.waitForStatus(task, "working");
    await first.runtime.stop();
    expect(first.record(task)).toMatchObject({ status: "working" });

    const second = await runtime({ storage });
    await second.waitForStatus(task, "done");
    expect(second.texts(task)).not.toContain("Interrupted because the agent restarted.");
  });

  it("picks records left active by a crash back up", async () => {
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
    await second.waitForStatus(task, "done");
  });
});
