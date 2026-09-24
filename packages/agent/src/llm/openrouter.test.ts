import { describe, expect, it, vi } from "vitest";
import { createOpenRouterClient } from "./openrouter";
import { type LlmCompletionRequest, LlmError } from "./types";

const API_KEY = "test-key";

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function jsonResponse(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function completionPayload(overrides: Record<string, unknown> = {}, message: object = {}) {
  return {
    id: "gen-1",
    model: "deepseek/deepseek-v4.1-flash",
    choices: [
      { message: { role: "assistant", content: "Hello!", ...message }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.00042 },
    ...overrides,
  };
}

function fakeFetch(...responses: Array<Response | Error | (() => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

function client(
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof createOpenRouterClient>[0]> = {},
) {
  return createOpenRouterClient({
    apiKey: API_KEY,
    defaultModel: "deepseek/deepseek-v4.1-flash",
    fetch: fetchImpl,
    ...extra,
  });
}

const simple: LlmCompletionRequest = { messages: [{ role: "user", content: "hi" }] };

describe("createOpenRouterClient", () => {
  it("requires an api key and a default model", () => {
    expect(() => createOpenRouterClient({ apiKey: "", defaultModel: "m" })).toThrow(/apiKey/);
    expect(() => createOpenRouterClient({ apiKey: API_KEY, defaultModel: "" })).toThrow(
      /defaultModel/,
    );
  });

  it("sends a well-formed chat completion request", async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(completionPayload()));
    const llm = client(fetch, {
      appUrl: "https://example.com/app",
      baseUrl: "https://gw.test/v1/",
    });
    await llm.complete({
      model: "openai/gpt-test",
      system: "Be brief.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        },
      ],
      jsonSchema: { name: "answer schema", schema: { type: "object" } },
      maxTokens: 256,
      temperature: 0.2,
      reasoning: "off",
      plugins: [{ id: "web", max_results: 3 }],
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://gw.test/v1/chat/completions");
    expect(call?.init.method).toBe("POST");
    expect(call?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call?.headers["x-title"]).toBe("Daily Do List");
    expect(call?.headers["http-referer"]).toBe("https://example.com/app");
    expect(call?.body).toEqual({
      model: "openai/gpt-test",
      stream: false,
      usage: { include: true },
      messages: [
        { role: "system", content: "Be brief." },
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
          ],
        },
      ],
      max_tokens: 256,
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer_schema", strict: true, schema: { type: "object" } },
      },
      provider: { require_parameters: true },
      reasoning: { effort: "none" },
      plugins: [{ id: "web", max_results: 3 }],
    });
  });

  it("maps reasoning efforts and omits reasoning by default", async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse(completionPayload()),
      jsonResponse(completionPayload()),
      jsonResponse(completionPayload()),
    );
    const llm = client(fetch);
    await llm.complete(simple);
    await llm.complete({ ...simple, reasoning: "high" });
    await llm.complete({ ...simple, reasoning: "max" });
    expect(calls[0]?.body.reasoning).toBeUndefined();
    expect(calls[0]?.body.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(calls[0]?.headers["http-referer"]).toBeUndefined();
    expect(calls[1]?.body.reasoning).toEqual({ effort: "high", exclude: true });
    expect(calls[2]?.body.reasoning).toEqual({ effort: "max", exclude: true });
  });

  it("parses text, usage, reported cost, citations and finish reason", async () => {
    const payload = completionPayload(
      {},
      {
        content: [
          { type: "text", text: "Paris " },
          { type: "text", text: "is sunny." },
        ],
        annotations: [
          {
            type: "url_citation",
            url_citation: { url: "https://a.example/w", title: "Weather", content: "Sunny" },
          },
          { type: "url_citation", url_citation: { url: "https://a.example/w", title: "dup" } },
          { type: "file", file: {} },
        ],
      },
    );
    const { fetch } = fakeFetch(jsonResponse(payload));
    const result = await client(fetch).complete(simple);
    expect(result.text).toBe("Paris is sunny.");
    expect(result.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, costUsd: 0.00042 });
    expect(result.citations).toEqual([
      { url: "https://a.example/w", title: "Weather", content: "Sunny" },
    ]);
    expect(result.finishReason).toBe("stop");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.json).toBeUndefined();
  });

  it("estimates cost from the price table when OpenRouter omits it", async () => {
    const usage = {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 500_000 },
    };
    const { fetch } = fakeFetch(
      jsonResponse(completionPayload({ usage })),
      jsonResponse(completionPayload({ usage, model: "unknown/model" })),
    );
    const llm = client(fetch);
    const known = await llm.complete(simple);
    expect(known.usage.costUsd).toBeCloseTo(0.5 * 0.14 + 0.5 * 0.0042 + 0.42, 10);
    const unknown = await llm.complete({ ...simple, model: "unknown/model" });
    expect(unknown.usage.costUsd).toBeUndefined();
  });

  it("extracts JSON from fenced or chatty structured output", async () => {
    const { fetch } = fakeFetch(
      jsonResponse(completionPayload({}, { content: 'Sure!\n```json\n{"city":"Paris"}\n```' })),
      jsonResponse(completionPayload({}, { content: 'Result: {"a": {"b": "}"}} — done' })),
      jsonResponse(completionPayload({}, { content: "no json here" })),
    );
    const llm = client(fetch);
    const schema = { jsonSchema: { name: "out", schema: { type: "object" } } };
    expect((await llm.complete({ ...simple, ...schema })).json).toEqual({ city: "Paris" });
    expect((await llm.complete({ ...simple, ...schema })).json).toEqual({ a: { b: "}" } });
    expect((await llm.complete({ ...simple, ...schema })).json).toBeUndefined();
  });

  it("retries on 429 and network errors, honoring Retry-After", async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({ error: { message: "Rate limited", code: 429 } }, 429, { "retry-after": "0" }),
      new TypeError("fetch failed"),
      jsonResponse(completionPayload()),
    );
    const llm = client(fetch, { maxRetries: 2 });
    const started = Date.now();
    const result = await llm.complete(simple);
    expect(result.text).toBe("Hello!");
    expect(calls).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("does not retry client errors and surfaces them as LlmError", async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({ error: { message: "Invalid model", code: 400 } }, 400),
    );
    const error = await client(fetch)
      .complete(simple)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: 400, retryable: false });
    expect((error as Error).message).toContain("Invalid model");
    expect((error as Error).message).not.toContain(API_KEY);
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxRetries on persistent server errors", async () => {
    const failure = () =>
      jsonResponse({ error: { message: "upstream down" } }, 503, { "retry-after": "0" });
    const { fetch, calls } = fakeFetch(failure, failure, failure);
    const error = await client(fetch, { maxRetries: 2 })
      .complete(simple)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "LlmError", status: 503, retryable: true });
    expect(calls).toHaveLength(3);
  });

  it("treats errors embedded in a 200 response as failures", async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse({ error: { message: "Provider returned error", code: 400 } }),
    );
    const error = await client(fetch)
      .complete(simple)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("stops immediately when the caller aborts", async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const error = await client(fetch)
      .complete({ ...simple, signal: controller.signal })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "LlmError", retryable: false, message: "Request aborted" });
    expect(calls).toHaveLength(1);
  });

  it("enforces timeoutMs as an overall deadline", async () => {
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const error = await client(hanging as unknown as typeof fetch)
      .complete({ ...simple, timeoutMs: 50 })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "LlmError", message: "Request timed out after 50ms" });
    expect(hanging).toHaveBeenCalledTimes(1);
  });
});
