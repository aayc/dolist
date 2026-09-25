import { decodePersistedThreadJournal } from "@ddl/contract";
import { errorResult, type ToolResult, type ToolSpec, textResult } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { describe, expect, it, vi } from "vitest";
import { type AgentScript, ScriptedHarness } from "../../harness/scripted";
import type { AgentRole, ToolCallDecision, ToolCallRequest } from "../../harness/types";
import { createThreadStore, threadJournalPath } from "../store";
import { journalingHarness, outputForModel, UNRECORDED_CALL_REASON } from "./tool-ledger";

const NOW = Date.UTC(2026, 8, 25, 12);
/** Shaped like an OpenRouter key (built here so no key-like literal sits in the source). */
const FAKE_KEY = ["sk", "or", "v1", "a".repeat(26)].join("-");

function tool(name: string, run: () => Promise<ToolResult> = async () => textResult("done")) {
  const execute = vi.fn(run);
  const spec: ToolSpec = {
    name,
    label: `Label of ${name}`,
    description: name,
    parameters: { type: "object", properties: {} },
    safety: {},
    execute,
  };
  return { spec, execute };
}

async function setup(options: {
  tools: ToolSpec[];
  script: AgentScript;
  gate?: (call: ToolCallRequest) => Promise<ToolCallDecision>;
  role?: AgentRole;
  thread?: boolean;
}) {
  const storage = new MemoryStorageProvider({ now: () => NOW });
  const store = createThreadStore({ storage, now: () => NOW, flushDelayMs: 1_000_000 });
  const { id } = store.create({ taskId: "tsk_1", notePath: null, title: "t" });
  await store.flush();
  const gate = vi.fn(options.gate ?? (async () => ({ allow: true }) as ToolCallDecision));
  const harness = journalingHarness(new ScriptedHarness({ script: options.script }), {
    journal: store,
    threadFor: () => (options.thread === false ? null : id),
  });
  const session = await harness.createSession({
    sessionId: "sess_1",
    role: options.role ?? "subagent",
    systemPrompt: "",
    tools: options.tools,
    model: "m",
    cwd: "/tmp",
    beforeToolCall: gate,
  });
  const journal = async () => {
    const file = await storage.read(threadJournalPath(id));
    return file ? decodePersistedThreadJournal(file.content, id).events : [];
  };
  return { storage, store, id, gate, session, journal };
}

describe("the tool ledger around a harness", () => {
  it("has 'about to run' on disk before an effectful call executes, and the result after", async () => {
    let onDiskWhenRun: string[] = [];
    let s!: Awaited<ReturnType<typeof setup>>;
    const send = tool("slack_send", async () => {
      onDiskWhenRun = (await s.journal()).map((e) => e.type);
      return textResult("Sent");
    });
    s = await setup({
      tools: [send.spec],
      script: async (ctx) => {
        await ctx.callTool("slack_send", { text: "Thanks!" });
      },
      gate: async () =>
        ({
          allow: true,
          summary: "Press Send in Slack",
          via: "approval",
          approvalId: "apr_1",
          effectful: true,
        }) as ToolCallDecision,
    });
    await s.session.prompt("go");
    expect(onDiskWhenRun).toEqual([
      "thread.created",
      "tool.requested",
      "tool.decided",
      "tool.started",
    ]);
    await s.store.flush();
    const events = await s.journal();
    expect(events.slice(1).map((e) => e.type)).toEqual([
      "tool.requested",
      "tool.decided",
      "tool.started",
      "tool.finished",
    ]);
    expect(events[2]).toMatchObject({ allowed: true, via: "approval", approvalId: "apr_1" });
    expect(events[3]).toMatchObject({ target: "Press Send in Slack", approvalId: "apr_1" });
    expect(events[4]).toMatchObject({ outcome: "ok", output: "Sent" });
    expect(s.store.openToolCalls(s.id)).toEqual([]);
    expect(s.gate).toHaveBeenCalledTimes(1);
  });

  it("doesn't wait for the disk before a call that changes nothing", async () => {
    let onDiskWhenRun: string[] = [];
    let s!: Awaited<ReturnType<typeof setup>>;
    const read = tool("read_page", async () => {
      onDiskWhenRun = (await s.journal()).map((e) => e.type);
      return textResult("page");
    });
    s = await setup({
      tools: [read.spec],
      script: async (ctx) => {
        await ctx.callTool("read_page", {});
      },
      gate: async () =>
        ({ allow: true, summary: "Read the page", effectful: false }) as ToolCallDecision,
    });
    await s.session.prompt("go");
    expect(onDiskWhenRun).toEqual(["thread.created"]);
    await s.store.flush();
    expect((await s.journal())[3]).toMatchObject({ type: "tool.started", effectful: false });
  });

  it("records a blocked call and never runs it", async () => {
    const send = tool("slack_send");
    const s = await setup({
      tools: [send.spec],
      script: async (ctx) => {
        await ctx.callTool("slack_send", {});
      },
      gate: async () => ({ allow: false, reason: "User denied" }),
    });
    await s.session.prompt("go");
    await s.store.flush();
    expect(send.execute).not.toHaveBeenCalled();
    expect((await s.journal()).slice(1)).toMatchObject([
      { type: "tool.requested", tool: "slack_send" },
      { type: "tool.decided", allowed: false, reason: "User denied" },
      {
        type: "tool.finished",
        outcome: "blocked",
        output: "Blocked by safety policy: User denied",
      },
    ]);
  });

  it("blocks a call the gate allowed when its record can't be written, and never runs it", async () => {
    const send = tool("slack_send");
    const s = await setup({
      tools: [send.spec],
      script: async (ctx) => {
        await ctx.callTool("slack_send", {});
      },
    });
    const append = vi.spyOn(s.storage, "append").mockRejectedValueOnce(new Error("disk full"));
    await s.session.prompt("go");
    expect(s.gate).toHaveBeenCalledTimes(1);
    expect(send.execute).not.toHaveBeenCalled();
    append.mockRestore();
    await s.store.flush();
    const events = await s.journal();
    expect(events.find((e) => e.type === "tool.finished")).toMatchObject({
      outcome: "blocked",
      output: `Blocked: ${UNRECORDED_CALL_REASON}.`,
    });
    expect(s.store.openToolCalls(s.id)).toEqual([]);
  });

  it("keeps what the model read for a subagent, and nothing of an orchestrator's results", async () => {
    const failing = tool("fails", async () => errorResult("no network"));
    const run = async (role: AgentRole) => {
      const s = await setup({
        role,
        tools: [failing.spec],
        script: async (ctx) => {
          await ctx.callTool("fails", {});
        },
      });
      await s.session.prompt("go");
      await s.store.flush();
      return (await s.journal()).find((e) => e.type === "tool.finished");
    };
    expect(await run("subagent")).toMatchObject({ outcome: "error", output: "Error: no network" });
    const orchestrator = await run("orchestrator");
    expect(orchestrator).toMatchObject({ outcome: "error" });
    expect(orchestrator).not.toHaveProperty("output");
  });

  it("journals nothing for a session without a thread, but still asks the gate", async () => {
    const send = tool("slack_send");
    const s = await setup({
      thread: false,
      tools: [send.spec],
      script: async (ctx) => {
        await ctx.callTool("slack_send", {});
      },
    });
    await s.session.prompt("go");
    await s.store.flush();
    expect(s.gate).toHaveBeenCalledTimes(1);
    expect(send.execute).toHaveBeenCalledTimes(1);
    expect((await s.journal()).map((e) => e.type)).toEqual(["thread.created"]);
  });

  it("records the input display-safe", async () => {
    const send = tool("slack_send");
    const s = await setup({
      tools: [send.spec],
      script: async (ctx) => {
        await ctx.callTool("slack_send", {
          token: FAKE_KEY,
          text: "hi",
        });
      },
    });
    await s.session.prompt("go");
    await s.store.flush();
    expect((await s.journal())[1]).toMatchObject({
      type: "tool.requested",
      input: { token: "[redacted]", text: "hi" },
    });
  });
});

describe("outputForModel", () => {
  it("reads like the harnesses phrase results", () => {
    expect(outputForModel(textResult("ok"), false, false)).toBe("ok");
    expect(outputForModel(errorResult("boom"), true, false)).toBe("Error: boom");
    expect(outputForModel(errorResult("Error: boom"), true, false)).toBe("Error: boom");
    expect(outputForModel({ content: [] }, true, false)).toBe(
      "Error: the tool reported a failure without details",
    );
    expect(outputForModel(errorResult("Blocked by safety policy: no"), true, true)).toBe(
      "Blocked by safety policy: no",
    );
    expect(
      outputForModel(
        {
          content: [
            { type: "text", text: "shot" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
        false,
        false,
      ),
    ).toBe("shot\n[an image]");
    expect(outputForModel(textResult(`key ${FAKE_KEY}`), false, false)).toBe("key sk-…[redacted]");
  });
});
