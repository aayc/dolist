import { deferred, type ToolSpec, textResult } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorCliStatus } from "../src/harness/cursor/cli";
import { ScriptedHarness } from "../src/harness/scripted";
import { MockLlmClient } from "../src/llm/mock";
import type { OpenRouterKeyCheck } from "../src/llm/openrouter";
import { createAgentRuntime, UnknownThreadError } from "../src/runtime";
import { createFakeExecution, fakeSafety, testSettings } from "./helpers/fakes";
import { createTestRuntime, type TestRuntime, TODAY } from "./helpers/runtime";

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

  it("reports computer access and gives the orchestrator the desktop apps", async () => {
    const execution = {
      ...createFakeExecution({ computer: true }),
      apps: {
        runningApps: async () => [{ name: "Grok Bot", pid: 7, active: true, hidden: false }],
        installedApps: async () => [
          { name: "WhatsApp", path: "/Applications/WhatsApp.app" },
          { name: "1Password", path: "/Applications/1Password.app" },
        ],
      },
      computerAccess: async () => ({
        accessibility: false,
        screenRecording: false,
        appControl: true,
        hostApp: { name: "Terminal" },
      }),
    } as unknown as ReturnType<typeof createFakeExecution>;
    const digests: string[] = [];
    const t = await runtime({
      execution,
      scriptFor: () => async (ctx) => {
        if (ctx.role !== "orchestrator") return;
        digests.push(ctx.message);
        const id = /\] (\S+):/.exec(ctx.message)?.[1];
        await ctx.callTool("set_task_status", { taskId: id, status: "waiting_user" });
      },
    });
    await vi.waitFor(() => {
      expect(t.runtime.status().execution.computerAccess).toEqual({
        accessibility: false,
        screenRecording: false,
        appControl: true,
        hostApp: { name: "Terminal" },
      });
    }, WAIT);
    await t.storage.write(TODAY, "- [ ] Ask Grok Bot for a packing list\n");
    await t.waitForStatus("Ask Grok Bot for a packing list", "waiting_user");
    const digest = digests.at(-1)!;
    expect(digest).toContain("Desktop apps (computer): Grok Bot, WhatsApp.");
    expect(digest).toContain(
      "Computer access: missing — Accessibility and Screen Recording not allowed for “Terminal”.",
    );
    expect(digest).not.toContain("1Password");
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

  it("live mode with a rejected API key starts degraded with an actionable problem", async () => {
    process.env.OPENROUTER_API_KEY = "not-a-real-key";
    const checkApiKey = vi.fn(async () => ({
      status: "invalid" as const,
      httpStatus: 401,
      message: "User not found.",
    }));
    const t = await runtime({ mode: "live", overrides: { checkApiKey } });
    expect(checkApiKey).toHaveBeenCalledWith("not-a-real-key");
    expect(t.runtime.status().problem).toMatch(/OpenRouter rejected OPENROUTER_API_KEY \(401/);
    await t.storage.write(TODAY, "- [ ] Research standing desks\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(t.runtime.getTaskRecords(TODAY)).toEqual([]);
  });

  it("reads the OpenRouter key and endpoint from its env, not the process's", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const checkApiKey = vi.fn(async () => ({
      status: "invalid" as const,
      httpStatus: 401,
      message: "User not found.",
    }));
    const t = await runtime({
      mode: "live",
      llm: new MockLlmClient(),
      env: { OPENROUTER_API_KEY: "the-daemon-key" },
      overrides: { checkApiKey },
    });
    expect(checkApiKey).toHaveBeenCalledWith("the-daemon-key");
    expect(t.runtime.status().problem).toMatch(/OpenRouter rejected OPENROUTER_API_KEY/);
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

  it("live mode with the Cursor harness explains a missing or signed-out CLI", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const missing = await runtime({
      mode: "live",
      settings: { agent: { harness: "cursor" } },
      overrides: { checkCursorCli: async () => ({ state: "missing" }) },
    });
    expect(missing.runtime.status().problem).toContain(
      "Install it with `curl https://cursor.com/install -fsS | bash`",
    );
    const signedOut = await runtime({
      mode: "live",
      settings: { agent: { harness: "cursor" } },
      overrides: { checkCursorCli: async () => ({ state: "signed_out", binary: "/bin/agent" }) },
    });
    expect(signedOut.runtime.status().problem).toMatch(/not signed in\. Run `agent login`/);
    await signedOut.storage.write(TODAY, "- [ ] Research standing desks\n");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(signedOut.runtime.getTaskRecords(TODAY)).toEqual([]);
  });

  it("the Cursor harness needs no OpenRouter key and reports the Cursor model", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const checkApiKey = vi.fn();
    const t = await runtime({
      mode: "live",
      settings: { agent: { harness: "cursor", cursorModel: "gpt-5.5" } },
      overrides: {
        checkApiKey,
        checkCursorCli: async () => ({ state: "ready", binary: "/bin/agent" }),
      },
    });
    expect(t.runtime.status().problem).toBeUndefined();
    expect(t.runtime.status().model).toBe("gpt-5.5");
    expect(checkApiKey).not.toHaveBeenCalled();
  });

  // The first switch loads the Cursor harness modules, which takes seconds on a loaded machine.
  it("re-creates the harness when the harness setting changes", { timeout: 30_000 }, async () => {
    delete process.env.OPENROUTER_API_KEY;
    const checkCursorCli = vi.fn(async () => ({ state: "ready" as const, binary: "/bin/agent" }));
    const t = await runtime({ mode: "live", overrides: { checkCursorCli } });
    expect(t.runtime.status().problem).toContain("OPENROUTER_API_KEY");
    const settings = testSettings();
    t.runtime.updateSettings({ ...settings, agent: { ...settings.agent, harness: "cursor" } });
    await vi.waitFor(() => expect(t.runtime.status().problem).toBeUndefined(), {
      ...WAIT,
      timeout: 20_000,
    });
    expect(checkCursorCli).toHaveBeenCalledTimes(1);
    expect(t.runtime.status().model).toBe(settings.agent.cursorModel);
    t.runtime.updateSettings(settings);
    await vi.waitFor(
      () => expect(t.runtime.status().problem).toContain("OPENROUTER_API_KEY"),
      WAIT,
    );
    expect(t.runtime.status().model).toBe(settings.agent.model);
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

describe("AgentRuntime warm-up", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function prewarmingHarness() {
    const prewarm = vi.fn(async () => {});
    return {
      prewarm,
      harness: Object.assign(new ScriptedHarness({ scriptFor: () => async () => {} }), { prewarm }),
    };
  }

  it("typing in a watched note prewarms the harness, at most every 5 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { prewarm, harness } = prewarmingHarness();
    const t = await runtime({ harness });
    t.runtime.noteEditorActivity("Projects/plan.md", 0);
    expect(prewarm).not.toHaveBeenCalled();
    t.runtime.noteEditorActivity(TODAY, 0);
    t.runtime.noteEditorActivity(TODAY, 1);
    expect(prewarm).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 5_000);
    t.runtime.noteEditorActivity(TODAY, 2);
    expect(prewarm).toHaveBeenCalledTimes(2);
  });

  it("a watched note changed elsewhere (no typing reported) prewarms too", async () => {
    const { prewarm, harness } = prewarmingHarness();
    const t = await runtime({ harness });
    await t.storage.write(TODAY, "- [ ] Renew passport");
    await vi.waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1), WAIT);
  });

  it("notes the startup scan finds don't prewarm", async () => {
    const { prewarm, harness } = prewarmingHarness();
    const storage = new MemoryStorageProvider();
    await storage.write(TODAY, "- [ ] Renew passport");
    await runtime({ harness, storage });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(prewarm).not.toHaveBeenCalled();
  });

  it("a paused agent doesn't prewarm", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { prewarm, harness } = prewarmingHarness();
    const t = await runtime({ harness, settings: { agent: { enabled: false } } });
    t.runtime.noteEditorActivity(TODAY, 0);
    expect(prewarm).not.toHaveBeenCalled();
  });
});

describe("AgentRuntime startup", () => {
  it("is created without waiting for the harness check, which start() waits for", async () => {
    const check = deferred<CursorCliStatus>();
    // Resolving while the check is pending is the point: the daemon listens once this returns.
    const t = await runtime({
      mode: "live",
      settings: { agent: { harness: "cursor" } },
      overrides: { checkCursorCli: () => check.promise },
      start: false,
    });
    let started = false;
    const start = t.runtime.start().then(() => {
      started = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(false);
    check.resolve({ state: "signed_out", binary: "/usr/local/bin/agent" });
    await start;
    expect(t.runtime.status().problem).toBeTruthy();
  });
});

describe("AgentRuntime OpenRouter key", () => {
  const stubTool = (name: string): ToolSpec => ({
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    safety: { readOnly: true },
    execute: async () => textResult("ok"),
  });

  /** A live runtime whose orchestrator sends every new task to a web subagent that notes its tools. */
  async function webRun(keyCheck: OpenRouterKeyCheck) {
    process.env.OPENROUTER_API_KEY = "the-configured-key";
    const checkApiKey = vi.fn(async () => keyCheck);
    const tools: string[][] = [];
    const t = await runtime({
      mode: "live",
      llm: new MockLlmClient(),
      overrides: {
        checkApiKey,
        createWebTools: () => [stubTool("web_fetch"), stubTool("web_search")],
      },
      scriptFor: (options) =>
        options.role === "orchestrator"
          ? async (ctx) => {
              for (const match of ctx.message.matchAll(/\[added\] (\S+):/g)) {
                await ctx.callTool("spawn_subagent", {
                  taskId: match[1],
                  goal: "look it up",
                  capabilities: ["web"],
                });
              }
            }
          : async (ctx) => {
              tools.push(ctx.tools.map((tool) => tool.name));
              await ctx.callTool("finish_task", { status: "done", summary: "ok" });
            },
    });
    await t.storage.write(TODAY, "- [ ] Find banana bread recipes\n");
    await t.waitForStatus("Find banana bread recipes", "done");
    expect(checkApiKey).toHaveBeenCalledWith("the-configured-key");
    return tools[0] ?? [];
  }

  it("a key OpenRouter rejects counts as none: no web_search that can only fail", async () => {
    const tools = await webRun({ status: "invalid", httpStatus: 401, message: "User not found." });
    expect(tools).toContain("web_fetch");
    expect(tools).not.toContain("web_search");
  });

  it("a key OpenRouter accepts keeps our web_search", async () => {
    const tools = await webRun({ status: "valid" });
    expect(tools).toContain("web_search");
  });
});
