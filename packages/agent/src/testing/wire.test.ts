import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { AssistantTurn } from "./brain/types";
import {
  brainRequestFromChat,
  type CompletionContext,
  chatCompletionBody,
  chatCompletionChunks,
  splitText,
  wireToolCalls,
  wireUsage,
} from "./wire";

function context(turn: AssistantTurn): CompletionContext {
  let n = 0;
  return {
    id: "gen-1",
    model: "m",
    created: 1,
    usage: wireUsage(10, 5),
    toolCalls: wireToolCalls(turn, () => `call_${++n}`),
  };
}

/** Rebuilds a message from streamed chunks the way an OpenAI-compatible client does. */
function reassemble(chunks: Array<Record<string, unknown>>) {
  let content = "";
  let reasoning = "";
  let finish: string | null = null;
  let usage: unknown;
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    const choice = (chunk.choices as Array<Record<string, unknown>>)[0];
    if (!choice) continue;
    const delta = choice.delta as Record<string, unknown>;
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
    for (const call of (delta.tool_calls as Array<Record<string, unknown>>) ?? []) {
      const index = call.index as number;
      const fn = call.function as { name?: string; arguments?: string };
      calls[index] ??= { id: "", name: "", arguments: "" };
      if (typeof call.id === "string") calls[index].id = call.id;
      if (fn.name) calls[index].name = fn.name;
      calls[index].arguments += fn.arguments ?? "";
    }
    if (choice.finish_reason) finish = choice.finish_reason as string;
  }
  return { content, reasoning, calls, finish, usage };
}

const turn: fc.Arbitrary<AssistantTurn> = fc.record(
  {
    text: fc.string({ maxLength: 200 }),
    reasoning: fc.string({ minLength: 1, maxLength: 100 }),
    toolCalls: fc.array(
      fc.record({
        name: fc.stringMatching(/^[a-z_]{1,20}$/),
        arguments: fc.oneof(fc.dictionary(fc.string(), fc.jsonValue()), fc.string()),
      }),
      { maxLength: 4 },
    ),
  },
  { requiredKeys: [] },
);

describe("SSE chunks", () => {
  test.prop([turn, fc.integer({ min: 1, max: 40 }), fc.boolean()])(
    "re-assemble into exactly the turn (text, reasoning, tool calls, finish reason, usage)",
    (t, chunkChars, reasoning) => {
      const ctx = context(t);
      const chunks = chatCompletionChunks(t, ctx, { reasoning, chunkChars });
      const out = reassemble(chunks);
      expect(out.content).toBe(t.text ?? "");
      expect(out.reasoning).toBe(reasoning ? (t.reasoning ?? "") : "");
      expect(out.calls).toEqual(ctx.toolCalls);
      expect(out.finish).toBe(ctx.toolCalls.length > 0 ? "tool_calls" : "stop");
      expect(out.usage).toEqual(ctx.usage);
      expect((chunks[0]!.choices as Array<{ delta: unknown }>)[0]!.delta).toEqual({
        role: "assistant",
        content: "",
      });
      expect(chunks.at(-1)!.choices).toEqual([]);
    },
  );

  test.prop([fc.string({ maxLength: 300 }), fc.integer({ min: 1, max: 30 })])(
    "splitText loses nothing",
    (text, size) => {
      expect(splitText(text, size).join("")).toBe(text);
    },
  );

  it("keeps words together when they fit", () => {
    expect(splitText("Looking into it now", 8)).toEqual(["Looking ", "into it ", "now"]);
  });
});

describe("non-streaming completion", () => {
  it("carries text, tool calls, reasoning and url citations", () => {
    const t: AssistantTurn = {
      text: "1. Result",
      reasoning: "thinking",
      toolCalls: [{ name: "x", arguments: { a: 1 } }],
      citations: [{ url: "https://www.example.com/a", title: "A" }],
    };
    const body = chatCompletionBody(t, context(t), { reasoning: false });
    expect(body).toMatchObject({
      object: "chat.completion",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "1. Result",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "x", arguments: '{"a":1}' } },
            ],
            annotations: [
              {
                type: "url_citation",
                url_citation: { url: "https://www.example.com/a", title: "A" },
              },
            ],
          },
        },
      ],
    });
    expect((body.choices as Array<{ message: object }>)[0]!.message).not.toHaveProperty(
      "reasoning",
    );
  });
});

describe("brainRequestFromChat", () => {
  it("maps an OpenAI-style body, pairing tool results with their calls", () => {
    const request = brainRequestFromChat({
      model: "deepseek/deepseek-v4.1-flash",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "developer", content: [{ type: "text", text: "Be brief." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "Hi" },
            { type: "image_url", image_url: { url: "data:," } },
          ],
        },
        {
          role: "assistant",
          content: null,
          reasoning: "hmm",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "echo", arguments: '{"t":1}' } },
          ],
        },
        { role: "tool", tool_call_id: "c1", content: "echoed" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "echo", description: "Echo", parameters: { type: "object" } },
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "v", strict: true, schema: { type: "object" } },
      },
      plugins: [{ id: "web", max_results: 2 }],
      reasoning: { effort: "none" },
      max_completion_tokens: 100,
      temperature: 0,
    });
    expect(request).toEqual({
      model: "deepseek/deepseek-v4.1-flash",
      system: "You are helpful.\n\nBe brief.",
      messages: [
        { role: "user", content: "Hi[image]" },
        {
          role: "assistant",
          content: "",
          reasoning: "hmm",
          toolCalls: [{ id: "c1", name: "echo", arguments: '{"t":1}' }],
        },
        { role: "tool", toolCallId: "c1", name: "echo", content: "echoed" },
      ],
      tools: [{ name: "echo", description: "Echo", parameters: { type: "object" } }],
      responseFormat: { type: "json_schema", name: "v", schema: { type: "object" }, strict: true },
      plugins: [{ id: "web", max_results: 2 }],
      reasoning: "none",
      maxTokens: 100,
      temperature: 0,
    });
  });

  it("tolerates junk", () => {
    expect(brainRequestFromChat(null)).toEqual({ model: "", system: "", messages: [], tools: [] });
    expect(brainRequestFromChat({ messages: [1, { role: "x" }], tools: [{}] }).messages).toEqual(
      [],
    );
  });
});
