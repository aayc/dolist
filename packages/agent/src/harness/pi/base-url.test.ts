/**
 * PiHarness pointed at another OpenAI-compatible endpoint (`baseUrl`): the real Pi agent loop over
 * HTTP against the fake OpenRouter — streaming, reasoning, tool calls through the gate, parallel
 * calls, retries, and aborting a stream.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ToolSpec, textResult } from "@ddl/core";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeBrain, type FakeBrain } from "../../testing/brain/brain";
import { type FakeOpenRouter, startFakeOpenRouter } from "../../testing/fake-openrouter";
import type { HarnessEvent, HarnessSession, ToolCallRequest } from "../types";
import { PiHarness } from "./harness";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tool(name: string, readOnly = true): ToolSpec {
  return {
    name,
    label: name,
    description: `The ${name} tool`,
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    safety: { readOnly },
    execute: async (input) => textResult(`${name}: ${(input as { text: string }).text}`),
  };
}

async function setup(
  brain: FakeBrain,
  options: { chunkDelayMs?: number; retry?: { maxRetries: number; baseDelayMs: number } } = {},
) {
  const server: FakeOpenRouter = await startFakeOpenRouter({
    brain,
    chunkChars: 6,
    ...(options.chunkDelayMs ? { chunkDelayMs: options.chunkDelayMs } : {}),
  });
  const home = await mkdtemp(path.join(tmpdir(), "ddl-pi-baseurl-"));
  cleanup.push(
    () => server.close(),
    () => rm(home, { recursive: true, force: true }),
  );
  const harness = new PiHarness({
    apiKey: server.apiKey,
    home,
    baseUrl: `${server.baseUrl}/`,
    appUrl: "https://example.com/app",
    ...(options.retry ? { retry: options.retry } : {}),
  });
  const events: HarnessEvent[] = [];
  const gate: ToolCallRequest[] = [];
  const session: HarnessSession = await harness.createSession({
    sessionId: "thr_baseurl",
    role: "subagent",
    systemPrompt: "You are a test agent.",
    tools: [tool("echo"), tool("shout"), tool("danger", false)],
    model: "deepseek/deepseek-v4.1-flash",
    thinking: "low",
    cwd: home,
    beforeToolCall: async (call) => {
      gate.push(call);
      return call.toolName === "danger"
        ? { allow: false, reason: "not approved" }
        : { allow: true };
    },
    onEvent: (event) => events.push(event),
  });
  cleanup.push(() => session.dispose());
  return { server, session, events, gate };
}

describe("PiHarness with baseUrl (fake OpenRouter over HTTP)", () => {
  it("sends requests to the configured endpoint with our attribution and streams text back", async () => {
    const brain = createFakeBrain().enqueue({
      reasoning: "Thinking it over.",
      text: "Hello from the fake model.",
    });
    const { server, session, events } = await setup(brain);
    await session.prompt("Say hello");
    const [request] = server.chatRequests();
    expect(request).toMatchObject({ stream: true, authorized: true, status: 200, completed: true });
    expect(request!.headers).toMatchObject({
      "x-title": "Daily Do List",
      "http-referer": "https://example.com/app",
    });
    expect(request!.body).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      reasoning: { effort: "low" },
      stream_options: { include_usage: true },
    });
    expect(request!.brainRequest?.system.startsWith("You are a test agent.")).toBe(true);
    expect(request!.brainRequest?.tools.map((t) => t.name).sort()).toEqual([
      "danger",
      "echo",
      "shout",
    ]);
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.delta : ""))
      .join("");
    expect(text).toBe("Hello from the fake model.");
    expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThan(2);
    expect(events.some((e) => e.type === "thinking_delta")).toBe(true);
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
    expect(events.at(-1)).toEqual({ type: "idle" });
  });

  it("runs parallel tool calls through the gate and blocks what the gate refuses", async () => {
    const brain = createFakeBrain().enqueue(
      {
        toolCalls: [
          { name: "echo", arguments: { text: "one" } },
          { name: "shout", arguments: { text: "two" } },
          { name: "danger", arguments: { text: "three" } },
        ],
      },
      { text: "All done." },
    );
    const { server, session, events, gate } = await setup(brain);
    await session.prompt("Use the tools");
    expect(gate.map((g) => g.toolName)).toEqual(["echo", "shout", "danger"]);
    const ends = events.filter(
      (e): e is Extract<HarnessEvent, { type: "tool_end" }> => e.type === "tool_end",
    );
    expect(ends.map((e) => [e.toolName, e.isError, e.blocked ?? false])).toEqual([
      ["echo", false, false],
      ["shout", false, false],
      ["danger", true, true],
    ]);
    const second = server
      .chatRequests()[1]!
      .brainRequest!.messages.filter((m) => m.role === "tool");
    expect(second.map((m) => m.content)).toEqual([
      "echo: one",
      "shout: two",
      "Blocked by safety policy: not approved",
    ]);
  });

  it("retries a 429 quickly with the retry override", async () => {
    const brain = createFakeBrain().enqueue({ text: "Recovered." });
    const { server, session, events } = await setup(brain, {
      retry: { maxRetries: 2, baseDelayMs: 1 },
    });
    server.inject({ kind: "status", status: 429, retryAfter: 0 });
    await session.prompt("hi");
    expect(server.chatRequests().map((r) => r.status)).toEqual([429, 200]);
    expect(events.filter((e) => e.type === "message_end").at(-1)).toMatchObject({
      text: "Recovered.",
    });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("reports a truncated stream as an error once retries are exhausted", async () => {
    const brain = createFakeBrain();
    const { server, session, events } = await setup(brain, {
      retry: { maxRetries: 1, baseDelayMs: 1 },
    });
    server.inject({ kind: "truncate", afterChunks: 2 }, { times: 2 });
    await session.prompt("Reply with exactly the word: never");
    expect(server.chatRequests()).toHaveLength(2);
    expect(events.find((e) => e.type === "error")).toMatchObject({
      message: expect.stringMatching(/finish_reason|ended/i),
    });
    expect(events.at(-1)).toEqual({ type: "idle" });
  });

  it("aborting mid-stream closes the HTTP request", async () => {
    const brain = createFakeBrain().enqueue({ text: "a long answer ".repeat(30) });
    const { server, session, events } = await setup(brain, { chunkDelayMs: 10 });
    const run = session.prompt("talk");
    while (!events.some((e) => e.type === "text_delta"))
      await new Promise((resolve) => setTimeout(resolve, 2));
    await session.abort();
    await run;
    await server.waitForRequests(1, { endpoint: "chat" });
    expect(server.chatRequests()[0]?.aborted).toBe(true);
    expect(events.at(-1)).toEqual({ type: "idle" });
  });
});
