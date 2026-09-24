/**
 * Minimal one-shot LLM client used OUTSIDE the agent loop: the safety judge, orchestrator triage
 * helpers, web search, and evals. Agentic multi-turn work goes through the Harness instead.
 */
import type { JsonSchema } from "@ddl/core";

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

export type ReasoningEffort = "off" | "low" | "high" | "max";

export interface LlmCompletionRequest {
  /** OpenRouter model id; defaults to the client's configured model. */
  model?: string;
  system?: string;
  messages: LlmMessage[];
  /** Structured output via `response_format: { type: "json_schema" }`. Parsed into `json`. */
  jsonSchema?: { name: string; schema: JsonSchema; strict?: boolean };
  maxTokens?: number;
  temperature?: number;
  reasoning?: ReasoningEffort;
  /** OpenRouter plugins (e.g. `{ id: "web" }` for web search with citations). */
  plugins?: Array<{ id: "web"; max_results?: number; search_prompt?: string }>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Free-form tag for logs and metrics (`safety-judge`, `triage`, …). */
  purpose?: string;
}

export interface LlmUrlCitation {
  url: string;
  title?: string;
  content?: string;
}

export interface LlmCompletion {
  text: string;
  /** Present when `jsonSchema` was requested and the output parsed. */
  json?: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  latencyMs: number;
  citations?: LlmUrlCitation[];
  finishReason?: string;
}

export interface LlmClient {
  readonly defaultModel: string;
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;
}

export class LlmError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.retryable = retryable;
  }
}
