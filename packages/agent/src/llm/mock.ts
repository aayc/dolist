/**
 * Deterministic `LlmClient` for tests, evals in mock mode and `DDL_AGENT_MODE=mock`. Never touches
 * the network. Responses come from a responder function or a FIFO queue.
 */
import { parseJsonLoose } from "./json";
import {
  type LlmClient,
  type LlmCompletion,
  type LlmCompletionRequest,
  LlmError,
  type LlmMessage,
} from "./types";

/**
 * - `string`: the completion text (parsed into `json` when the request asked for a schema).
 * - `Error`: the call rejects with it.
 * - An object whose keys are all `LlmCompletion` fields and that has `text` or `json`: merged
 *   into the completion.
 * - Any other object/array: the structured output (`json`), with `text` set to its JSON.
 *   Wrap payloads that look like completions in `{ json: … }`.
 */
export type MockLlmResponse = string | Error | Partial<LlmCompletion> | object;

export type MockLlmResponder = (
  request: LlmCompletionRequest,
  callIndex: number,
) => MockLlmResponse | Promise<MockLlmResponse>;

export interface MockLlmClientOptions {
  defaultModel?: string;
}

const COMPLETION_KEYS = new Set<string>([
  "text",
  "json",
  "model",
  "usage",
  "latencyMs",
  "citations",
  "finishReason",
]);

export class MockLlmClient implements LlmClient {
  readonly defaultModel: string;
  /** Every request received, in order. */
  readonly calls: LlmCompletionRequest[] = [];
  private readonly responder: MockLlmResponder | undefined;
  private readonly queue: MockLlmResponse[];

  constructor(
    responses: MockLlmResponder | readonly MockLlmResponse[] = [],
    options: MockLlmClientOptions = {},
  ) {
    this.defaultModel = options.defaultModel ?? "mock/model";
    if (typeof responses === "function") {
      this.responder = responses;
      this.queue = [];
    } else {
      this.responder = undefined;
      this.queue = [...responses];
    }
  }

  /** Appends responses to the queue (used when no responder function was given). */
  enqueue(...responses: MockLlmResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  get pendingResponses(): number {
    return this.queue.length;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    const callIndex = this.calls.length;
    this.calls.push(request);
    if (request.signal?.aborted) throw new LlmError("Request aborted", undefined, false);
    const response = await this.nextResponse(request, callIndex);
    if (response instanceof Error) throw response;
    return toCompletion(response, request, request.model ?? this.defaultModel);
  }

  private async nextResponse(
    request: LlmCompletionRequest,
    callIndex: number,
  ): Promise<MockLlmResponse> {
    if (this.responder) return this.responder(request, callIndex);
    if (this.queue.length === 0) {
      throw new Error(`MockLlmClient: no queued response for call #${callIndex + 1}`);
    }
    return this.queue.shift() as MockLlmResponse;
  }
}

function toCompletion(
  response: Exclude<MockLlmResponse, Error>,
  request: LlmCompletionRequest,
  model: string,
): LlmCompletion {
  let partial: Partial<LlmCompletion>;
  if (typeof response === "string") partial = { text: response };
  else if (isCompletionLike(response)) partial = response;
  else partial = { json: response, text: JSON.stringify(response) };

  const text = partial.text ?? (partial.json === undefined ? "" : JSON.stringify(partial.json));
  const completion: LlmCompletion = {
    text,
    model: partial.model ?? model,
    usage: partial.usage ?? {
      inputTokens: estimateTokens(promptChars(request)),
      outputTokens: estimateTokens(text.length),
      costUsd: 0,
    },
    latencyMs: partial.latencyMs ?? 0,
  };
  if (partial.json !== undefined) completion.json = partial.json;
  else if (request.jsonSchema) {
    const parsed = parseJsonLoose(text);
    if (parsed.ok) completion.json = parsed.value;
  }
  if (partial.citations) completion.citations = partial.citations;
  completion.finishReason = partial.finishReason ?? "stop";
  return completion;
}

function isCompletionLike(value: object): value is Partial<LlmCompletion> {
  if (Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => COMPLETION_KEYS.has(key))) return false;
  const record = value as Record<string, unknown>;
  return typeof record.text === "string" || "json" in record;
}

function promptChars(request: LlmCompletionRequest): number {
  return (request.system?.length ?? 0) + request.messages.reduce((n, m) => n + messageChars(m), 0);
}

function messageChars(message: LlmMessage): number {
  if (typeof message.content === "string") return message.content.length;
  return message.content.reduce((n, part) => n + (part.type === "text" ? part.text.length : 0), 0);
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
