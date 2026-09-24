/**
 * The FakeBrain as an in-process `LlmClient` (the one-shot client behind the safety judge and
 * `web_search`), for runs without the HTTP fake.
 */
import { DEFAULT_MODEL } from "@ddl/core";
import { parseJsonLoose } from "../llm/json";
import {
  type LlmClient,
  type LlmCompletion,
  type LlmCompletionRequest,
  LlmError,
  type LlmMessage,
} from "../llm/types";
import type { FakeBrain } from "./brain/brain";
import type { BrainMessage, BrainRequest } from "./brain/types";

export interface FakeLlmClient extends LlmClient {
  /** Every request, in order. */
  readonly calls: LlmCompletionRequest[];
}

export function createFakeLlmClient(
  brain: FakeBrain,
  options: { defaultModel?: string } = {},
): FakeLlmClient {
  const calls: LlmCompletionRequest[] = [];
  const defaultModel = options.defaultModel ?? DEFAULT_MODEL;
  return {
    defaultModel,
    calls,
    async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
      calls.push(request);
      if (request.signal?.aborted) throw new LlmError("Request aborted", undefined, false);
      const brainRequest = toBrainRequest(request, request.model ?? defaultModel);
      const turn = brain.decide(brainRequest);
      if (turn.hang) {
        await new Promise<never>((_, reject) => {
          const abort = () => reject(new LlmError("Request aborted", undefined, false));
          if (request.signal?.aborted) abort();
          request.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (turn.error) {
        const status = turn.error.status ?? 500;
        throw new LlmError(
          `OpenRouter ${status}: ${turn.error.message}`,
          status,
          status === 429 || status >= 500,
        );
      }
      const usage = brain.usage(brainRequest, turn);
      const text = turn.text ?? "";
      const completion: LlmCompletion = {
        text,
        model: brainRequest.model,
        usage: {
          inputTokens: usage.promptTokens,
          outputTokens: usage.completionTokens,
          costUsd: 0,
        },
        latencyMs: 0,
        finishReason: turn.finishReason ?? "stop",
      };
      if (request.jsonSchema) {
        const parsed = parseJsonLoose(text);
        if (parsed.ok) completion.json = parsed.value;
      }
      if (turn.citations && turn.citations.length > 0) completion.citations = turn.citations;
      return completion;
    },
  };
}

function toBrainRequest(request: LlmCompletionRequest, model: string): BrainRequest {
  const system = [
    request.system ?? "",
    ...request.messages.filter((m) => m.role === "system").map(textOf),
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages: BrainMessage[] = request.messages
    .filter((m) => m.role !== "system")
    .map((m) =>
      m.role === "assistant"
        ? { role: "assistant", content: textOf(m), toolCalls: [] }
        : { role: "user", content: textOf(m) },
    );
  return {
    model,
    system,
    messages,
    tools: [],
    ...(request.jsonSchema
      ? {
          responseFormat: {
            type: "json_schema" as const,
            name: request.jsonSchema.name,
            schema: request.jsonSchema.schema,
            ...(request.jsonSchema.strict !== undefined
              ? { strict: request.jsonSchema.strict }
              : {}),
          },
        }
      : {}),
    ...(request.plugins ? { plugins: request.plugins } : {}),
    ...(request.reasoning
      ? { reasoning: request.reasoning === "off" ? "none" : request.reasoning }
      : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };
}

function textOf(message: LlmMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("");
}
