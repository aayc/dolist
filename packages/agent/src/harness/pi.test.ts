/**
 * Drives the real Pi agent loop (AgentSession, tool validation, extension hooks, queues) with
 * pi-ai's in-process faux provider standing in for OpenRouter. No network.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deferred, type ToolResult, type ToolSpec, textResult } from "@ddl/core";
import {
  type FauxProviderHandle,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  getSystemMessageText,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellExecOptions, ShellExecutor } from "../execution/types";
import { createPiHarness } from "./pi";
import { PiHarness } from "./pi/harness";
import type { HarnessEvent, HarnessSession, HarnessSessionOptions, ToolCallRequest } from "./types";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

interface Setup {
  faux: FauxProviderHandle;
  harness: PiHarness;
  home: string;
  cwd: string;
  events: HarnessEvent[];
  gateCalls: ToolCallRequest[];
  contexts: TranscriptContext[];
  create(overrides?: Partial<HarnessSessionOptions>): Promise<HarnessSession>;
}

async function setup(
  responses: FauxResponseStep[],
  options: { tokensPerSecond?: number; textOnly?: boolean } = {},
): Promise<Setup> {
  const home = await tempDir("ddl-pi-home-");
  const cwd = await tempDir("ddl-pi-cwd-");
  const contexts: TranscriptContext[] = [];
  const faux = fauxProvider({
    provider: "faux-test",
    models: [{ id: "faux-model", reasoning: true }],
    ...(options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond } : {}),
  });
  faux.setResponses(
    responses.map(
      (step): FauxResponseStep =>
        async (context, streamOptions, state, model) => {
          contexts.push(context);
          return typeof step === "function" ? step(context, streamOptions, state, model) : step;
        },
    ),
  );
  const harness = new PiHarness(
    { apiKey: "test-key", home },
    {
      createModelRuntime: async (agentDir) => {
        const runtime = await ModelRuntime.create({
          authPath: path.join(agentDir, "auth.json"),
          modelsPath: path.join(agentDir, "models.json"),
          allowModelNetwork: false,
        });
        runtime.registerNativeProvider(faux.provider);
        return runtime;
      },
      resolveModel: () =>
        options.textOnly ? { ...faux.getModel(), input: ["text"] } : faux.getModel(),
      ripgrepAvailable: () => false,
    },
  );
  const events: HarnessEvent[] = [];
  const gateCalls: ToolCallRequest[] = [];
  return {
    faux,
    harness,
    home,
    cwd,
    events,
    gateCalls,
    contexts,
    create: (overrides = {}) =>
      harness.createSession({
        sessionId: "thr_test",
        role: "subagent",
        systemPrompt: "You are a careful test agent.",
        tools: [],
        model: "faux-model",
        thinking: "low",
        cwd,
        beforeToolCall: async (call) => {
          gateCalls.push(call);
          return { allow: true };
        },
        onEvent: (event) => events.push(event),
        ...overrides,
      }),
  };
}

function tool(name: string, execute: ToolSpec["execute"], extra: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name,
    label: name,
    description: `The ${name} tool`,
    parameters: { type: "object", properties: { text: { type: "string" } } },
    safety: { readOnly: true },
    execute,
    ...extra,
  };
}

const toolTurn = (...calls: Array<ReturnType<typeof fauxToolCall>>) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

function toolResults(context: TranscriptContext): Array<Extract<Message, { role: "toolResult" }>> {
  return context.messages.filter(
    (m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult",
  );
}

function resultText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.map((c) => c.text ?? "").join("");
}

function systemPrompt(context: TranscriptContext): string {
  const first = context.messages[0];
  return first?.role === "system" ? getSystemMessageText(first) : "";
}

function toolNames(context: TranscriptContext): string[] {
  return context.messages
    .flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []) : []))
    .map((t) => t.name)
    .sort();
}

function userTexts(context: TranscriptContext): string[] {
  return context.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : resultText(m as never)));
}

const types = (events: HarnessEvent[]) => events.map((e) => e.type);

describe("createPiHarness", () => {
  it("validates its options", () => {
    expect(() => createPiHarness({ apiKey: "", home: "/tmp/x" })).toThrow(/apiKey/);
    expect(createPiHarness({ apiKey: "k", home: "/tmp/x" }).name).toBe("pi");
  });
});

describe("PiHarness (faux provider)", () => {
  it("streams an answer bracketed by turn_start/idle with stable message ids", async () => {
    const s = await setup([
      fauxAssistantMessage([
        fauxThinking("Let me think."),
        { type: "text", text: "Hello from Pi" },
      ]),
    ]);
    const session = await s.create();
    await session.prompt("Say hello");

    expect(s.events[0]).toEqual({ type: "turn_start" });
    expect(s.events.at(-1)).toEqual({ type: "idle" });
    const deltas = s.events.filter((e) => e.type === "text_delta");
    const end = s.events.find((e) => e.type === "message_end");
    expect(end).toMatchObject({ text: "Hello from Pi" });
    expect(new Set(deltas.map((d) => d.messageId))).toEqual(new Set([end?.messageId]));
    expect(deltas.map((d) => d.delta).join("")).toBe("Hello from Pi");
    expect(s.events.some((e) => e.type === "thinking_delta")).toBe(true);
    expect(s.events.some((e) => e.type === "usage")).toBe(true);
    expect(userTexts(s.contexts[0]!)).toEqual(["Say hello"]);
    expect(session.isRunning).toBe(false);
  });

  it("tells tools whether the model sees images, and passes their images to it", async () => {
    for (const textOnly of [false, true]) {
      const seen: Array<boolean | undefined> = [];
      const look = tool("look", async (_input, ctx) => {
        seen.push(ctx.images);
        return {
          content: [
            { type: "text", text: "a drawing" },
            ...(ctx.images
              ? [{ type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" }]
              : []),
          ],
        };
      });
      const s = await setup(
        [toolTurn(fauxToolCall("look", {}, { id: "call_1" })), fauxAssistantMessage("done")],
        { textOnly },
      );
      const session = await s.create({ tools: [look] });
      await session.prompt("Look");
      expect(seen, `textOnly: ${textOnly}`).toEqual([!textOnly]);
      const [result] = toolResults(s.contexts[1]!);
      expect(result!.content.map((c) => c.type)).toEqual(textOnly ? ["text"] : ["text", "image"]);
    }
  });

  it("runs approved custom tools and reports the ToolSpec's own result", async () => {
    const echo = tool("echo", async (input) =>
      textResult(`echo: ${(input as { text: string }).text}`, { length: 2 }),
    );
    const s = await setup([
      toolTurn(fauxToolCall("echo", { text: "hi" }, { id: "call_1" })),
      fauxAssistantMessage("done"),
    ]);
    const session = await s.create({ tools: [echo] });
    await session.prompt("Use echo");

    expect(s.gateCalls).toEqual([
      {
        sessionId: "thr_test",
        role: "subagent",
        toolCallId: "call_1",
        toolName: "echo",
        input: { text: "hi" },
        spec: echo,
      },
    ]);
    const start = s.events.findIndex((e) => e.type === "tool_start");
    const end = s.events.findIndex((e) => e.type === "tool_end");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(s.events[end]).toEqual({
      type: "tool_end",
      toolCallId: "call_1",
      toolName: "echo",
      result: { content: [{ type: "text", text: "echo: hi" }], details: { length: 2 } },
      isError: false,
    });
    const [seen] = toolResults(s.contexts[1]!);
    expect(seen).toMatchObject({ toolCallId: "call_1", isError: false });
    expect(resultText(seen!)).toBe("echo: hi");
  });

  it("never executes calls the gate denies, and tells the model why", async () => {
    const execute = vi.fn(async () => textResult("deleted"));
    const s = await setup([
      toolTurn(fauxToolCall("delete_everything", { text: "all" }, { id: "call_x" })),
      fauxAssistantMessage("I could not do that."),
    ]);
    const session = await s.create({
      tools: [tool("delete_everything", execute, { safety: { destructive: true } })],
      beforeToolCall: async () => ({ allow: false, reason: "destructive actions need approval" }),
    });
    await session.prompt("Delete everything");

    expect(execute).not.toHaveBeenCalled();
    expect(s.events.find((e) => e.type === "tool_end")).toEqual({
      type: "tool_end",
      toolCallId: "call_x",
      toolName: "delete_everything",
      result: {
        content: [
          { type: "text", text: "Blocked by safety policy: destructive actions need approval" },
        ],
        isError: true,
      },
      isError: true,
      blocked: true,
    });
    const [seen] = toolResults(s.contexts[1]!);
    expect(seen?.isError).toBe(true);
    expect(resultText(seen!)).toBe("Blocked by safety policy: destructive actions need approval");
  });

  it("fails closed when the gate throws", async () => {
    const execute = vi.fn(async () => textResult("ran"));
    const s = await setup([
      toolTurn(fauxToolCall("echo", {}, { id: "c1" })),
      fauxAssistantMessage("ok"),
    ]);
    const session = await s.create({
      tools: [tool("echo", execute)],
      beforeToolCall: async () => {
        throw new Error("evaluator crashed");
      },
    });
    await session.prompt("go");
    expect(execute).not.toHaveBeenCalled();
    expect(s.events.find((e) => e.type === "tool_end")).toMatchObject({
      blocked: true,
      isError: true,
    });
  });

  it("surfaces ToolSpec error results to the model as errors", async () => {
    const failure: ToolResult = {
      content: [{ type: "text", text: "no such note" }],
      details: { code: 404 },
      isError: true,
    };
    const s = await setup([
      toolTurn(fauxToolCall("read_note", {}, { id: "c1" })),
      fauxAssistantMessage("ok"),
    ]);
    const session = await s.create({ tools: [tool("read_note", async () => failure)] });
    await session.prompt("read it");
    expect(s.events.find((e) => e.type === "tool_end")).toMatchObject({
      result: failure,
      isError: true,
    });
    const [seen] = toolResults(s.contexts[1]!);
    expect(seen?.isError).toBe(true);
    expect(resultText(seen!)).toBe("Error: no such note");
  });

  it("rejects invalid arguments before the gate or the tool see them", async () => {
    const execute = vi.fn(async () => textResult("ran"));
    const strict = tool("strict", execute, {
      parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
    });
    const s = await setup([
      toolTurn(fauxToolCall("strict", { wrong: true }, { id: "c1" })),
      fauxAssistantMessage("ok"),
    ]);
    const session = await s.create({ tools: [strict] });
    await session.prompt("go");
    expect(s.gateCalls).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(s.events.find((e) => e.type === "tool_end")).toMatchObject({ isError: true });
  });

  it("exposes exactly the requested tools", async () => {
    const shell: ShellExecutor = { exec: vi.fn() };
    const cases: Array<[HarnessSessionOptions["builtinTools"], string[]]> = [
      [undefined, ["echo"]],
      [{ files: true }, ["echo", "edit", "read", "write"]],
      [{ files: true, readOnly: true, shell }, ["echo", "find", "ls", "read"]],
      [{ files: false, shell }, ["bash", "echo"]],
    ];
    for (const [builtinTools, expected] of cases) {
      const s = await setup([fauxAssistantMessage("ok")]);
      const session = await s.create({
        tools: [tool("echo", async () => textResult("x"))],
        ...(builtinTools ? { builtinTools } : {}),
      });
      await session.prompt("hi");
      expect(toolNames(s.contexts[0]!)).toEqual(expected);
      await session.dispose();
    }
  });

  it("runs bash through the ShellExecutor, gated, with streamed output", async () => {
    const exec = vi.fn(async (_command: string, options: ShellExecOptions) => {
      options.onData?.("hello\n");
      options.onData?.("world\n");
      return {
        exitCode: 0,
        output: "hello\nworld\n",
        timedOut: false,
        truncated: false,
        durationMs: 3,
      };
    });
    const s = await setup([
      toolTurn(fauxToolCall("bash", { command: "echo hello" }, { id: "b1" })),
      fauxAssistantMessage("ran it"),
    ]);
    const session = await s.create({ builtinTools: { files: false, shell: { exec } } });
    await session.prompt("run it");

    expect(s.gateCalls).toEqual([
      {
        sessionId: "thr_test",
        role: "subagent",
        toolCallId: "b1",
        toolName: "bash",
        input: { command: "echo hello" },
      },
    ]);
    expect(exec).toHaveBeenCalledWith(
      "echo hello",
      expect.objectContaining({ cwd: expect.stringContaining("ddl-pi-cwd-") }),
    );
    expect(exec.mock.calls[0]?.[1]).not.toHaveProperty("env");
    expect(s.events.some((e) => e.type === "tool_update")).toBe(true);
    const end = s.events.find((e) => e.type === "tool_end");
    expect(end).toMatchObject({ toolName: "bash", isError: false });
    expect(resultText(toolResults(s.contexts[1]!)[0]!)).toContain("hello\nworld");
  });

  it("confines file tools to the workspace", async () => {
    const s = await setup([
      toolTurn(
        fauxToolCall("read", { path: "inside.txt" }, { id: "r1" }),
        fauxToolCall("read", { path: "../outside.txt" }, { id: "r2" }),
      ),
      fauxAssistantMessage("ok"),
    ]);
    await writeFile(path.join(s.cwd, "inside.txt"), "workspace file");
    await writeFile(path.join(path.dirname(s.cwd), "outside.txt"), "private").catch(() => {});
    const session = await s.create({ builtinTools: { files: true } });
    await session.prompt("read both");
    const [inside, outside] = toolResults(s.contexts[1]!);
    expect(resultText(inside!)).toContain("workspace file");
    expect(outside?.isError).toBe(true);
    expect(resultText(outside!)).toMatch(/outside the task workspace/);
    await rm(path.join(path.dirname(s.cwd), "outside.txt"), { force: true });
  });

  it("is hermetic: our prompt only, no discovered context/extensions, nothing persisted", async () => {
    const s = await setup([fauxAssistantMessage("ok")]);
    await writeFile(path.join(s.cwd, "AGENTS.md"), "MARKER_FROM_AGENTS_FILE");
    await mkdir(path.join(s.cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(path.join(s.cwd, ".pi", "extensions", "evil.ts"), "throw new Error('loaded!')");
    await writeFile(path.join(s.cwd, ".pi", "SYSTEM.md"), "MARKER_FROM_SYSTEM_FILE");
    const guided = tool("echo", async () => textResult("x"), {
      promptGuidelines: ["Only echo short text."],
    });
    const session = await s.create({ tools: [guided] });
    await session.prompt("hi");
    await session.dispose();

    const prompt = systemPrompt(s.contexts[0]!);
    expect(prompt.startsWith("You are a careful test agent.")).toBe(true);
    expect(prompt).toContain("- echo: Only echo short text.");
    expect(prompt).not.toContain("MARKER_FROM");
    expect(toolNames(s.contexts[0]!)).toEqual(["echo"]);
    expect((await readdir(s.cwd)).sort()).toEqual([".pi", "AGENTS.md"]);
    expect((await readdir(path.join(s.home, "pi"))).sort()).toEqual([
      "auth.json",
      "models-store.json",
    ]);
  });

  it("queues prompts sent while a run is in progress", async () => {
    const s = await setup(
      [fauxAssistantMessage("first answer, streamed slowly"), fauxAssistantMessage("second")],
      {
        tokensPerSecond: 400,
      },
    );
    const session = await s.create();
    const first = session.prompt("one");
    expect(session.isRunning).toBe(true);
    const second = session.prompt("two");
    await Promise.all([first, second]);

    expect(s.contexts.map(userTexts)).toEqual([["one"], ["one", "two"]]);
    expect(types(s.events).filter((t) => t === "turn_start" || t === "idle")).toEqual([
      "turn_start",
      "idle",
      "turn_start",
      "idle",
    ]);
    expect(session.isRunning).toBe(false);
  });

  it("delivers steering to the in-flight run", async () => {
    const release = deferred<void>();
    const started = deferred<void>();
    const slow = tool("slow", async () => {
      started.resolve();
      await release.promise;
      return textResult("slow done");
    });
    const s = await setup([
      toolTurn(fauxToolCall("slow", {}, { id: "s1" })),
      fauxAssistantMessage("adjusted"),
    ]);
    const session = await s.create({ tools: [slow] });
    const run = session.prompt("start");
    await started.promise;
    await session.steer("Also mention the weather.");
    release.resolve();
    await run;

    expect(userTexts(s.contexts[1]!)).toEqual(["start", "Also mention the weather."]);
    expect(types(s.events).filter((t) => t === "turn_start")).toHaveLength(1);
  });

  it("steer on an idle session starts a run", async () => {
    const s = await setup([fauxAssistantMessage("ok")]);
    const session = await s.create();
    await session.steer("hello");
    expect(userTexts(s.contexts[0]!)).toEqual(["hello"]);
  });

  it("aborts the current run; the prompt resolves and the session stays usable", async () => {
    const s = await setup(
      [
        fauxAssistantMessage(
          "a long answer that will be cut off well before it finishes streaming",
        ),
        fauxAssistantMessage("again"),
      ],
      { tokensPerSecond: 50 },
    );
    const session = await s.create();
    const firstDelta = deferred<void>();
    const run = session.prompt("talk");
    const poll = setInterval(() => {
      if (s.events.some((e) => e.type === "text_delta")) firstDelta.resolve();
    }, 5);
    await firstDelta.promise;
    clearInterval(poll);
    await session.abort();
    await run;
    expect(s.events.at(-1)).toEqual({ type: "idle" });
    expect(s.events.some((e) => e.type === "error")).toBe(false);
    await session.prompt("again");
    expect(s.events.filter((e) => e.type === "message_end").at(-1)).toMatchObject({
      text: "again",
    });
  });

  it("an abort issued before Pi starts streaming still stops that run", async () => {
    const s = await setup([fauxAssistantMessage("should never be fully delivered")], {
      tokensPerSecond: 50,
    });
    const session = await s.create();
    const run = session.prompt("talk");
    await session.abort();
    await run;
    const ends = s.events.filter((e) => e.type === "message_end");
    expect(ends.every((e) => e.text !== "should never be fully delivered")).toBe(true);
    expect(s.events.at(-1)).toEqual({ type: "idle" });
  });

  it("dispose ends the session; later prompts are no-ops and tools are refused", async () => {
    const s = await setup([fauxAssistantMessage("ok")]);
    const session = await s.create();
    await session.prompt("hi");
    await session.dispose();
    await session.dispose();
    const before = s.faux.state.callCount;
    await session.prompt("ignored");
    await session.steer("ignored");
    expect(s.faux.state.callCount).toBe(before);
  });

  it("disposes the session when its signal aborts", async () => {
    const controller = new AbortController();
    const s = await setup([fauxAssistantMessage("a slow answer that keeps going and going")], {
      tokensPerSecond: 50,
    });
    const session = await s.create({ signal: controller.signal });
    const run = session.prompt("talk");
    controller.abort();
    await run;
    const calls = s.faux.state.callCount;
    expect(calls).toBeLessThanOrEqual(1);
    expect(s.events.some((e) => e.type === "message_end" && e.text.includes("keeps going"))).toBe(
      false,
    );
    await session.prompt("ignored");
    expect(s.faux.state.callCount).toBe(calls);
    await expect(s.create({ signal: controller.signal })).rejects.toThrow(/aborted/);
  });

  it("reports model failures as an error event and still resolves", async () => {
    const s = await setup([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "401 Unauthorized: invalid credentials",
      }),
    ]);
    const session = await s.create();
    await session.prompt("hi");
    expect(s.events).toContainEqual({
      type: "error",
      message: "401 Unauthorized: invalid credentials",
    });
    expect(s.events.at(-1)).toEqual({ type: "idle" });
    expect(s.events.some((e) => e.type === "message_end")).toBe(false);
  });

  it("keeps running when an event listener throws", async () => {
    const s = await setup([fauxAssistantMessage("fine")]);
    const session = await s.create({
      onEvent: () => {
        throw new Error("listener bug");
      },
    });
    await expect(session.prompt("hi")).resolves.toBeUndefined();
  });

  it("rejects invalid or conflicting tool sets", async () => {
    const s = await setup([]);
    const echo = tool("echo", async () => textResult("x"));
    await expect(s.create({ tools: [echo, echo] })).rejects.toThrow(/Duplicate/);
    await expect(s.create({ tools: [tool("bad name!", echo.execute)] })).rejects.toThrow(
      /Invalid tool name/,
    );
    await expect(
      s.create({
        tools: [tool("bash", echo.execute)],
        builtinTools: { files: false, shell: { exec: vi.fn() } },
      }),
    ).rejects.toThrow(/conflicts/);
    await expect(
      s.create({ tools: [tool("weird", echo.execute, { parameters: { type: "array" } })] }),
    ).rejects.toThrow(/object schema/);
  });
});
