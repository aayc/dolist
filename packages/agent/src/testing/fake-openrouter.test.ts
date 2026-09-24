import { silentLogger } from "@ddl/core";
import { afterEach, describe, expect, it } from "vitest";
import { checkOpenRouterKey, createOpenRouterClient } from "../llm/openrouter";
import { LlmError } from "../llm/types";
import { createLlmJudge } from "../safety/llm-judge";
import { createFakeBrain } from "./brain/brain";
import { FAKE_OPENROUTER_KEY, type FakeOpenRouter, startFakeOpenRouter } from "./fake-openrouter";

const servers: FakeOpenRouter[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(options: Parameters<typeof startFakeOpenRouter>[0] = {}) {
  const s = await startFakeOpenRouter(options);
  servers.push(s);
  return s;
}

function client(s: FakeOpenRouter, maxRetries = 2) {
  return createOpenRouterClient({
    apiKey: s.apiKey,
    defaultModel: "deepseek/deepseek-v4.1-flash",
    baseUrl: s.baseUrl,
    maxRetries,
  });
}

async function streamChat(
  s: FakeOpenRouter,
  body: object,
  key = s.apiKey,
): Promise<{ status: number; events: string[] }> {
  const response = await fetch(`${s.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ stream: true, model: "m", ...body }),
  });
  const text = await response.text();
  return {
    status: response.status,
    events: text
      .split("\n\n")
      .filter(Boolean)
      .map((e) => e.replace(/^data: /, "")),
  };
}

describe("fake OpenRouter: endpoints", () => {
  it("serves /key for the configured key only, and can be flipped to invalid", async () => {
    const s = await server();
    expect(s.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/);
    expect(s.apiKey).toBe(FAKE_OPENROUTER_KEY);
    expect(await checkOpenRouterKey(s.apiKey, { baseUrl: s.baseUrl })).toEqual({ status: "valid" });
    expect(await checkOpenRouterKey("wrong", { baseUrl: s.baseUrl })).toEqual({
      status: "invalid",
      httpStatus: 401,
      message: "User not found.",
    });
    s.setKeyValid(false);
    expect((await checkOpenRouterKey(s.apiKey, { baseUrl: s.baseUrl })).status).toBe("invalid");
  });

  it("lists models without auth and 404s unknown routes", async () => {
    const s = await server({ models: ["a/b", "c/d"] });
    const models = (await (await fetch(`${s.baseUrl}/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(models.data.map((m) => m.id)).toEqual(["a/b", "c/d"]);
    const missing = await fetch(`${s.baseUrl}/nope`);
    expect(missing.status).toBe(404);
    expect(s.requests.map((r) => r.endpoint)).toEqual(["models", "other"]);
  });

  it("rejects chat requests without the right bearer key", async () => {
    const s = await server();
    const { status, events } = await streamChat(s, { messages: [] }, "wrong-key");
    expect(status).toBe(401);
    expect(JSON.parse(events[0]!)).toEqual({ error: { message: "User not found.", code: 401 } });
    expect(s.chatRequests()[0]).toMatchObject({ authorized: false, status: 401 });
  });

  it("rejects bodies that aren't JSON", async () => {
    const s = await server();
    const response = await fetch(`${s.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.apiKey}` },
      body: "{nope",
    });
    expect(response.status).toBe(400);
  });
});

describe("fake OpenRouter: the one-shot client", () => {
  it("answers plain, structured (judge) and web-plugin requests through OpenRouterClient", async () => {
    const s = await server();
    const llm = client(s);
    const plain = await llm.complete({
      messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
      reasoning: "off",
    });
    expect(plain).toMatchObject({
      text: "pong",
      model: "deepseek/deepseek-v4.1-flash",
      finishReason: "stop",
    });
    expect(plain.usage.inputTokens).toBeGreaterThan(0);
    expect(plain.usage.costUsd).toBeGreaterThan(0);

    const search = await llm.complete({
      messages: [{ role: "user", content: "Search query: robot vacuums" }],
      plugins: [{ id: "web", max_results: 3 }],
    });
    expect(search.citations?.map((c) => c.url)).toEqual([
      "https://www.example.com/guides/robot-vacuums",
      "https://example.org/reviews/robot-vacuums",
      "https://example.net/answers/robot-vacuums",
    ]);

    const judge = createLlmJudge({ llm, timeoutMs: 2_000, logger: silentLogger });
    const verdict = await judge.judge({
      ctx: {
        toolName: "mcp__shop__checkout",
        input: {},
        hints: {},
        role: "subagent",
        taskId: "t",
        threadId: "h",
      },
      summary: "Checkout the cart",
      input: { cart: "c1" },
      signals: [],
    });
    expect(verdict).toMatchObject({
      decision: "require_approval",
      source: "llm",
      categories: ["payment"],
    });
    const judgeBody = s.chatRequests().at(-1)!.body as Record<string, unknown>;
    expect(judgeBody).toMatchObject({
      stream: false,
      temperature: 0,
      reasoning: { effort: "none" },
      usage: { include: true },
    });
  });

  it("retries a 429 with Retry-After and then succeeds", async () => {
    const s = await server();
    s.inject({ kind: "status", status: 429, retryAfter: 0 }, { times: 2 });
    const result = await client(s).complete({
      messages: [{ role: "user", content: "Reply with exactly the word: ok" }],
    });
    expect(result.text).toBe("ok");
    expect(s.chatRequests().map((r) => r.status)).toEqual([429, 429, 200]);
  });

  it("surfaces a persistent 500 as a retryable LlmError with the upstream message", async () => {
    const s = await server();
    s.inject({ kind: "status", status: 500, message: "upstream exploded" }, { times: 10 });
    const error = await client(s, 0)
      .complete({ messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({
      status: 500,
      retryable: true,
      message: "OpenRouter 500: upstream exploded",
    });
  });

  it("reports a malformed JSON body as a retryable error", async () => {
    const s = await server();
    s.inject({ kind: "malformed-json" });
    const error = await client(s, 0)
      .complete({ messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: "OpenRouter returned invalid JSON",
      status: 200,
      retryable: true,
    });
    expect(s.chatRequests()[0]).toMatchObject({ fault: "malformed-json", status: 200 });
  });

  it("a brain failure becomes an HTTP error the client reports", async () => {
    const brain = createFakeBrain().fail({ message: "model is down", status: 503 });
    const s = await server({ brain });
    const error = await client(s, 0)
      .complete({ messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, message: "OpenRouter 503: model is down" });
  });

  it("applies latency, and the client's timeout gives up on a hung request", async () => {
    const s = await server({ latencyMs: 20 });
    const started = performance.now();
    await client(s).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    s.inject({ kind: "hang" });
    const error = await client(s, 0)
      .complete({ messages: [{ role: "user", content: "hi" }], timeoutMs: 100 })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ message: "Request timed out after 100ms" });
    await s.waitForRequests(2, { endpoint: "chat" });
    expect(s.chatRequests().at(-1)?.aborted).toBe(true);
  });
});

describe("fake OpenRouter: streaming", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "echo",
        description: "Echo",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    },
  ];

  it("streams role, reasoning, content and tool-call deltas, the finish reason, usage and [DONE]", async () => {
    const brain = createFakeBrain().enqueue({
      reasoning: "Let me think.",
      text: "Echoing now.",
      toolCalls: [{ name: "echo", arguments: { text: "hi" } }],
    });
    const s = await server({ brain, chunkChars: 4 });
    const { status, events } = await streamChat(s, {
      messages: [{ role: "user", content: "go" }],
      tools,
      reasoning: { effort: "low" },
    });
    expect(status).toBe(200);
    expect(events.at(-1)).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    const deltas = chunks.flatMap((c) => c.choices.map((ch: { delta: unknown }) => ch.delta));
    expect(deltas[0]).toEqual({ role: "assistant", content: "" });
    expect(
      deltas
        .filter((d) => d.reasoning)
        .map((d) => d.reasoning)
        .join(""),
    ).toBe("Let me think.");
    expect(
      deltas
        .filter((d) => d.content)
        .map((d) => d.content)
        .join(""),
    ).toBe("Echoing now.");
    const toolDeltas = deltas.filter((d) => d.tool_calls).map((d) => d.tool_calls[0]);
    expect(toolDeltas[0]).toEqual({
      index: 0,
      id: "call_fake_1",
      type: "function",
      function: { name: "echo", arguments: "" },
    });
    expect(
      toolDeltas
        .slice(1)
        .map((d) => d.function.arguments)
        .join(""),
    ).toBe('{"text":"hi"}');
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe(
      "tool_calls",
    );
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: expect.any(Number) },
    });
    expect(s.chatRequests()[0]).toMatchObject({
      stream: true,
      completed: true,
      toolCalls: [{ name: "echo" }],
    });
  });

  it("omits reasoning when it is turned off", async () => {
    const brain = createFakeBrain().enqueue({ reasoning: "secret", text: "ok" });
    const s = await server({ brain });
    const { events } = await streamChat(s, {
      messages: [{ role: "user", content: "go" }],
      reasoning: { effort: "none" },
    });
    expect(events.join("")).not.toContain("secret");
  });

  it("truncates or aborts streams on request", async () => {
    const s = await server({ chunkChars: 2 });
    s.inject({ kind: "truncate", afterChunks: 3 });
    const truncated = await streamChat(s, {
      messages: [{ role: "user", content: "Reply with exactly the word: abcdefgh" }],
    });
    expect(truncated.events).toHaveLength(3);
    expect(truncated.events.join("")).not.toContain("[DONE]");
    s.inject({ kind: "abort", afterChunks: 2 });
    const aborted = await streamChat(s, {
      messages: [{ role: "user", content: "hi there friend" }],
    }).catch((e: unknown) => e);
    expect(aborted).toBeInstanceOf(Error);
    await s.waitForRequests(2, { endpoint: "chat" });
    expect(s.chatRequests()[1]?.aborted).toBe(true);
  });

  it("spaces chunks for slow streams and can inject a broken SSE line", async () => {
    const s = await server({ chunkChars: 3 });
    s.inject({ kind: "slow", chunkDelayMs: 10 });
    const started = performance.now();
    await streamChat(s, {
      messages: [{ role: "user", content: "Reply with exactly the word: abcdefghijkl" }],
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
    s.inject({ kind: "malformed-json" });
    const broken = await streamChat(s, { messages: [{ role: "user", content: "hi" }] });
    expect(broken.events).toContain("{this is not json");
  });

  it("faults can target specific requests and run out", async () => {
    const s = await server();
    s.inject(
      { kind: "status", status: 418 },
      { match: (r) => JSON.stringify(r.body).includes("teapot"), times: 1 },
    );
    expect((await streamChat(s, { messages: [{ role: "user", content: "hello" }] })).status).toBe(
      200,
    );
    expect((await streamChat(s, { messages: [{ role: "user", content: "teapot" }] })).status).toBe(
      418,
    );
    expect((await streamChat(s, { messages: [{ role: "user", content: "teapot" }] })).status).toBe(
      200,
    );
    s.inject({ kind: "status", status: 500 }, { times: 5 });
    s.clearFaults();
    expect((await streamChat(s, { messages: [{ role: "user", content: "x" }] })).status).toBe(200);
  });
});
