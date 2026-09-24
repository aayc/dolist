import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedHarness } from "../src/harness/scripted";
import { createAgentRuntime, UnknownThreadError } from "../src/runtime";
import { createFakeExecution, fakeSafety, testSettings } from "./helpers/fakes";
import { createTestRuntime, isSubsequence, type TestRuntime, TODAY } from "./helpers/runtime";

const WAIT = { timeout: 4_000, interval: 5 };
let active: TestRuntime[] = [];
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
});

afterEach(async () => {
  for (const t of active) await t.runtime.stop();
  active = [];
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
});

async function runtime(options: Parameters<typeof createTestRuntime>[0] = {}) {
  const t = await createTestRuntime(options);
  active.push(t);
  return t;
}

describe("AgentRuntime status", () => {
  it("off mode: no watcher, explains how to enable", async () => {
    const t = await runtime({ mode: "off" });
    expect(t.runtime.status()).toMatchObject({
      mode: "off",
      enabled: false,
      running: 0,
      queued: 0,
      pendingApprovals: 0,
      execution: {
        provider: "fake",
        capabilities: { shell: true, browser: false, computer: false },
      },
    });
    expect(t.runtime.status().problem).toContain("DDL_AGENT_MODE=off");
    await t.storage.write(TODAY, "- [ ] Research standing desks\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(t.runtime.getTaskRecords(TODAY)).toEqual([]);
    await expect(t.runtime.setEnabled(true)).resolves.toBeUndefined();
  });

  it("mock mode: healthy and reports the mock model", async () => {
    const t = await runtime();
    expect(t.runtime.mode).toBe("mock");
    const status = t.runtime.status();
    expect(status).toMatchObject({ mode: "mock", enabled: true, model: "mock" });
    expect(status.problem).toBeUndefined();
  });

  it("live mode without an API key starts degraded and never crashes", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const t = await runtime({ mode: "live" });
    const status = t.runtime.status();
    expect(status.mode).toBe("live");
    expect(status.problem).toContain("OPENROUTER_API_KEY");
    await t.storage.write(TODAY, "- [ ] Research standing desks\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(t.runtime.getTaskRecords(TODAY)).toEqual([]);
    await t.runtime.setEnabled(false);
    await t.runtime.setEnabled(true);
    await expect(t.runtime.postUserMessage("thr_missing", "hi")).rejects.toBeInstanceOf(
      UnknownThreadError,
    );
  });

  it("live mode with an injected harness runs without a key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const t = await runtime({
      mode: "live",
      scriptFor: () => async (ctx) => {
        if (ctx.role !== "orchestrator") return;
        const id = /\] (\S+):/.exec(ctx.message)?.[1];
        await ctx.callTool("set_task_status", { taskId: id, status: "ignored" });
      },
    });
    expect(t.runtime.status()).toMatchObject({ mode: "live", model: testSettings().agent.model });
    expect(t.runtime.status().problem).toBeUndefined();
    await t.storage.write(TODAY, "- [ ] Water the plants\n");
    await t.waitForStatus("Water the plants", "ignored");
  });

  it("starts degraded (fail closed) when the safety system cannot start", async () => {
    const safety = fakeSafety({
      createSafetyEvaluator: () => {
        throw new Error("rules failed to load");
      },
    });
    const rt = await createAgentRuntime(
      {
        mode: "mock",
        storage: new MemoryStorageProvider(),
        settings: testSettings(),
        home: "/tmp/ddl-test-home",
        execution: createFakeExecution(),
      },
      safety.overrides,
    );
    await rt.start();
    expect(rt.status().problem).toContain("rules failed to load");
    await rt.stop();
  });

  it("emits status events when work starts and finishes", async () => {
    const t = await runtime();
    await t.storage.write(TODAY, "- [ ] Research standing desks\n");
    await t.waitForStatus("Research standing desks", "done");
    await vi.waitFor(() => expect(t.events.statuses.at(-1)?.running).toBe(0), WAIT);
    expect(t.events.statuses.some((s) => s.running === 1)).toBe(true);
  });
});

describe("AgentRuntime controls", () => {
  it("pauses watching when disabled and picks up edits made meanwhile when re-enabled", async () => {
    const t = await runtime();
    await t.runtime.setEnabled(false);
    expect(t.runtime.status().enabled).toBe(false);
    await t.storage.write(TODAY, "- [ ] Research standing desks\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(t.runtime.getTaskRecords(TODAY)).toEqual([]);
    await t.runtime.setEnabled(true);
    await t.waitForStatus("Research standing desks", "done");
  });

  it("applies a higher concurrency limit to queued work", async () => {
    const releases: Array<() => void> = [];
    const t = await runtime({
      settings: { agent: { maxConcurrentSubagents: 1 } },
      scriptFor: (options) =>
        options.role === "orchestrator"
          ? async (ctx) => {
              for (const match of ctx.message.matchAll(/\[added\] (\S+):/g)) {
                await ctx.callTool("spawn_subagent", {
                  taskId: match[1],
                  goal: "work",
                  capabilities: ["web"],
                });
              }
            }
          : async (ctx) => {
              await new Promise<void>((resolve) => releases.push(resolve));
              await ctx.callTool("finish_task", { status: "done", summary: "ok" });
            },
    });
    await t.storage.write(TODAY, "- [ ] First errand online\n- [ ] Second errand online\n");
    await t.waitForStatus("Second errand online", "queued");
    t.runtime.updateSettings(testSettings({ agent: { maxConcurrentSubagents: 2 } }));
    await t.waitForStatus("Second errand online", "working");
    expect(t.runtime.status()).toMatchObject({ running: 2, queued: 0 });
    await vi.waitFor(() => expect(releases).toHaveLength(2), WAIT);
    for (const release of releases) release();
    await t.waitForStatus("First errand online", "done");
    await t.waitForStatus("Second errand online", "done");
  });

  it("cancels a thread on request", async () => {
    const t = await runtime();
    const task = "Reserve a table for Friday";
    await t.storage.write(TODAY, `- [ ] ${task}\n`);
    await t.waitForStatus(task, "waiting_approval");
    await t.runtime.cancelThread(t.thread(task).id);
    await t.waitForStatus(task, "cancelled");
    expect(t.runtime.listApprovals({ status: "pending" })).toEqual([]);
    await expect(t.runtime.cancelThread("thr_missing")).rejects.toBeInstanceOf(UnknownThreadError);
  });

  it("keeps working when a runtime event listener throws", async () => {
    const t = await runtime();
    t.runtime.on("task.record", () => {
      throw new Error("listener bug");
    });
    await t.storage.write(TODAY, "- [ ] Research standing desks\n");
    await t.waitForStatus("Research standing desks", "done");
  });
});

describe("mock mode smoke test", () => {
  it("runs the default mock script end to end on a realistic note", async () => {
    const t = await runtime({ overrides: { mockWordDelayMs: 1 } });
    await t.storage.write(
      TODAY,
      [
        "- [ ] Research best standing desks under $500",
        "- [ ] Go to the gym",
        "- [ ] Book dentist appointment next week",
        "  - prefer mornings",
        "- [x] Paid rent",
        "- [ ] ",
        "",
        "Notes: https://example.com/ideas",
      ].join("\n"),
    );
    await t.waitForStatus("Research best standing desks under $500", "done");
    await t.waitForStatus("Go to the gym", "ignored");
    await t.waitForStatus("Book dentist appointment next week", "waiting_approval");
    const [approval] = t.runtime.listApprovals({ status: "pending" });
    await t.runtime.decideApproval(approval!.id, { decision: "approve" });
    await t.waitForStatus("Book dentist appointment next week", "done");

    expect(
      t.runtime
        .getTaskRecords(TODAY)
        .map((r) => r.text)
        .sort(),
    ).toEqual([
      "Book dentist appointment next week",
      "Go to the gym",
      "Research best standing desks under $500",
    ]);
    expect(
      isSubsequence(
        ["triaging", "working", "waiting_approval", "working", "done"],
        t.statusesOf("Book dentist appointment next week"),
      ),
    ).toBe(true);
    const threads = t.runtime.listThreads({ notePath: TODAY });
    expect(threads).toHaveLength(2);
    expect(threads.every((thread) => thread.artifactCount === 1)).toBe(true);
    expect(t.events.deltas.length).toBeGreaterThan(5);

    // A reply to a finished subagent resumes it.
    const desks = t.thread("Research best standing desks under $500");
    await t.runtime.postUserMessage(desks.id, "Only ones with a crank handle");
    await vi.waitFor(
      () => expect(t.texts("Research best standing desks under $500").at(-1)).toContain("Updated"),
      WAIT,
    );
    await t.waitForStatus("Research best standing desks under $500", "done");
  });

  it("uses the default ScriptedHarness in mock mode", async () => {
    const t = await runtime();
    expect(t.runtime.status().model).toBe("mock");
    expect(new ScriptedHarness({}).name).toBe("scripted");
  });
});
