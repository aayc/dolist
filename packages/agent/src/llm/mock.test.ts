import { describe, expect, it } from "vitest";
import { MockLlmClient } from "./mock";
import { LlmError } from "./types";

const ask = { messages: [{ role: "user" as const, content: "hello there" }] };

describe("MockLlmClient", () => {
  it("serves queued responses in order and records calls", async () => {
    const llm = new MockLlmClient(["first", "second"]);
    expect((await llm.complete(ask)).text).toBe("first");
    expect((await llm.complete({ ...ask, model: "x/y" })).model).toBe("x/y");
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.model).toBe("x/y");
    await expect(llm.complete(ask)).rejects.toThrow(/no queued response for call #3/);
  });

  it("treats plain objects as structured output", async () => {
    const llm = new MockLlmClient([{ decision: "allow", reason: "read only" }]);
    const result = await llm.complete({
      ...ask,
      jsonSchema: { name: "verdict", schema: { type: "object" } },
    });
    expect(result.json).toEqual({ decision: "allow", reason: "read only" });
    expect(JSON.parse(result.text)).toEqual({ decision: "allow", reason: "read only" });
  });

  it("merges completion-shaped objects", async () => {
    const citations = [{ url: "https://example.com" }];
    const llm = new MockLlmClient([
      { text: "cited", citations, usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 } },
      { json: { text: "payload that looks like a completion" } },
    ]);
    const first = await llm.complete(ask);
    expect(first).toMatchObject({ text: "cited", citations, usage: { costUsd: 0.5 } });
    const second = await llm.complete(ask);
    expect(second.json).toEqual({ text: "payload that looks like a completion" });
  });

  it("parses JSON text when a schema was requested", async () => {
    const llm = new MockLlmClient(['```json\n{"ok":true}\n```']);
    const result = await llm.complete({ ...ask, jsonSchema: { name: "o", schema: {} } });
    expect(result.json).toEqual({ ok: true });
  });

  it("supports responder functions, errors and deterministic usage", async () => {
    const llm = new MockLlmClient(
      (request, index) =>
        index === 1 ? new LlmError("boom", 500, true) : `echo:${request.purpose}`,
      { defaultModel: "mock/default" },
    );
    const result = await llm.complete({ ...ask, purpose: "triage" });
    expect(result).toMatchObject({
      text: "echo:triage",
      model: "mock/default",
      usage: { inputTokens: 3, outputTokens: 3, costUsd: 0 },
      finishReason: "stop",
    });
    await expect(llm.complete(ask)).rejects.toMatchObject({ name: "LlmError", status: 500 });
  });

  it("rejects when the request signal is already aborted", async () => {
    const llm = new MockLlmClient(["never"]);
    await expect(llm.complete({ ...ask, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
      LlmError,
    );
    expect(llm.pendingResponses).toBe(1);
  });
});
