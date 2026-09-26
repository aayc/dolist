/**
 * One-shot OpenRouter chat-completions client (non-streaming). Used outside the agent loop: the
 * safety judge, triage helpers, web search and evals. Never logs the API key or message content.
 */
import { errorMessage, isRecord, type Logger, silentLogger, sleep } from "@ddl/core";
import { parseJsonLoose } from "./json";
import { estimateCostUsd } from "./pricing";
import {
  type LlmClient,
  type LlmCompletion,
  type LlmCompletionRequest,
  LlmError,
  type LlmMessage,
  type LlmUrlCitation,
  type ReasoningEffort,
} from "./types";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_APP_NAME = "Daily Do List";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
const MAX_ERROR_DETAIL_CHARS = 400;

export interface OpenRouterClientOptions {
  apiKey: string;
  defaultModel: string;
  /** Sent as `X-Title` (OpenRouter app attribution). Default "Daily Do List". */
  appName?: string;
  /** Sent as `HTTP-Referer` when set. */
  appUrl?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Retries after the first attempt on 408/429/5xx and network errors. Default 2. */
  maxRetries?: number;
}

export function createOpenRouterClient(options: OpenRouterClientOptions): LlmClient {
  if (!options.apiKey) throw new Error("createOpenRouterClient: apiKey is required");
  if (!options.defaultModel) throw new Error("createOpenRouterClient: defaultModel is required");
  return new OpenRouterClient(options);
}

export type OpenRouterKeyCheck =
  | { status: "valid" }
  /** The key was rejected (revoked, deleted account, typo). */
  | { status: "invalid"; httpStatus: number; message: string }
  /** Could not tell (offline, timeout, OpenRouter error) — don't block on it. */
  | { status: "unknown"; message: string };

/** Checks a key against OpenRouter's key-info endpoint (free, no model call). Never throws. */
export async function checkOpenRouterKey(
  apiKey: string,
  options: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<OpenRouterKeyCheck> {
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${options.baseUrl ?? OPENROUTER_BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
    });
    if (response.ok) return { status: "valid" };
    if (response.status === 401 || response.status === 403) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: unknown };
      } | null;
      const message =
        typeof body?.error?.message === "string" ? body.error.message : response.statusText;
      return { status: "invalid", httpStatus: response.status, message };
    }
    return { status: "unknown", message: `HTTP ${response.status}` };
  } catch (error) {
    return { status: "unknown", message: errorMessage(error) };
  }
}

type AttemptOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; error: LlmError; retryAfterMs?: number };

class OpenRouterClient implements LlmClient {
  readonly defaultModel: string;
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;
  private readonly maxRetries: number;

  constructor(options: OpenRouterClientOptions) {
    this.defaultModel = options.defaultModel;
    this.endpoint = `${(options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
    this.headers = {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Title": options.appName ?? DEFAULT_APP_NAME,
      ...(options.appUrl ? { "HTTP-Referer": options.appUrl } : {}),
    };
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.logger = (options.logger ?? silentLogger).child({ component: "openrouter" });
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    const model = request.model ?? this.defaultModel;
    const body = JSON.stringify(buildRequestBody(model, request));
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = performance.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const log = { model, purpose: request.purpose };

    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attempt(body, signal, request.signal, timeoutMs);
      if (outcome.ok) {
        const completion = parseCompletion(outcome.payload, {
          model,
          wantJson: request.jsonSchema !== undefined,
          latencyMs: Math.round(performance.now() - startedAt),
        });
        this.logger.debug("completion", {
          ...log,
          latencyMs: completion.latencyMs,
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          costUsd: completion.usage.costUsd,
          attempts: attempt + 1,
        });
        return completion;
      }
      const { error } = outcome;
      const remainingMs = timeoutMs - (performance.now() - startedAt);
      const delayMs = retryDelayMs(attempt, outcome.retryAfterMs);
      if (!error.retryable || attempt >= this.maxRetries || delayMs >= remainingMs) {
        this.logger.debug("completion failed", {
          ...log,
          status: error.status,
          attempts: attempt + 1,
        });
        throw error;
      }
      this.logger.warn("retrying completion", { ...log, status: error.status, attempt, delayMs });
      try {
        await sleep(delayMs, signal);
      } catch {
        throw abortError(request.signal, timeoutMs);
      }
    }
  }

  private async attempt(
    body: string,
    signal: AbortSignal,
    userSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<AttemptOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.headers,
        body,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return { ok: false, error: abortError(userSignal, timeoutMs) };
      return {
        ok: false,
        error: new LlmError(`Network error: ${messageOf(error)}`, undefined, true),
      };
    }
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (signal.aborted) return { ok: false, error: abortError(userSignal, timeoutMs) };
      return {
        ok: false,
        error: new LlmError(`Network error: ${messageOf(error)}`, response.status, true),
      };
    }
    const payload = safeJsonParse(text);
    if (!response.ok) {
      const detail = errorDetail(payload) ?? text.slice(0, MAX_ERROR_DETAIL_CHARS);
      const error = new LlmError(
        `OpenRouter ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
        isRetryableStatus(response.status),
      );
      return retryAfterMs === undefined ? { ok: false, error } : { ok: false, error, retryAfterMs };
    }
    if (payload === undefined) {
      return {
        ok: false,
        error: new LlmError("OpenRouter returned invalid JSON", response.status, true),
      };
    }
    const embedded = embeddedError(payload);
    if (embedded) return { ok: false, error: embedded };
    return { ok: true, payload };
  }
}

// ── Request ──────────────────────────────────────────────────────────────────

export function buildRequestBody(
  model: string,
  request: LlmCompletionRequest,
): Record<string, unknown> {
  const messages = [
    ...(request.system ? [{ role: "system", content: request.system }] : []),
    ...request.messages.map(toWireMessage),
  ];
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
    usage: { include: true },
  };
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: sanitizeSchemaName(request.jsonSchema.name),
        strict: request.jsonSchema.strict ?? true,
        schema: request.jsonSchema.schema,
      },
    };
    // Route only to providers that honor response_format instead of silently ignoring it.
    body.provider = { require_parameters: true };
  }
  const reasoning = reasoningParam(request.reasoning);
  if (reasoning) body.reasoning = reasoning;
  if (request.plugins && request.plugins.length > 0) body.plugins = request.plugins;
  return body;
}

/**
 * OpenRouter's `effort: "none"` disables reasoning entirely (lowest latency); `exclude` only
 * hides reasoning that is still generated, billed and counted against `max_tokens`.
 */
function reasoningParam(effort: ReasoningEffort | undefined): Record<string, unknown> | undefined {
  if (effort === undefined) return undefined;
  if (effort === "off") return { effort: "none" };
  return { effort, exclude: true };
}

function toWireMessage(message: LlmMessage): { role: string; content: unknown } {
  if (typeof message.content === "string") return { role: message.role, content: message.content };
  return {
    role: message.role,
    content: message.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image_url", image_url: { url: toImageUrl(part.data, part.mimeType) } },
    ),
  };
}

function toImageUrl(data: string, mimeType: string): string {
  if (/^(data:|https?:\/\/)/i.test(data)) return data;
  return `data:${mimeType};base64,${data}`;
}

function sanitizeSchemaName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "output";
}

// ── Response ─────────────────────────────────────────────────────────────────

interface ParseContext {
  model: string;
  wantJson: boolean;
  latencyMs: number;
}

export function parseCompletion(payload: unknown, ctx: ParseContext): LlmCompletion {
  const choice = firstChoice(payload);
  if (!choice) throw new LlmError("OpenRouter returned no choices", undefined, true);
  const message = asRecord(choice.message) ?? {};
  const text = contentText(message.content);
  const usageRecord = asRecord(asRecord(payload)?.usage);
  const inputTokens = numberOr(usageRecord?.prompt_tokens, 0);
  const outputTokens = numberOr(usageRecord?.completion_tokens, 0);
  const cachedInputTokens = numberOr(
    asRecord(usageRecord?.prompt_tokens_details)?.cached_tokens,
    0,
  );
  const responseModel = asRecord(payload)?.model;
  const model = typeof responseModel === "string" && responseModel ? responseModel : ctx.model;
  const reportedCost = usageRecord?.cost;
  const costUsd =
    typeof reportedCost === "number"
      ? reportedCost
      : estimateCostUsd(ctx.model, { inputTokens, outputTokens, cachedInputTokens });

  const completion: LlmCompletion = {
    text,
    model,
    usage:
      costUsd === undefined
        ? { inputTokens, outputTokens }
        : { inputTokens, outputTokens, costUsd },
    latencyMs: ctx.latencyMs,
  };
  if (ctx.wantJson) {
    const parsed = parseJsonLoose(text);
    if (parsed.ok) completion.json = parsed.value;
  }
  const citations = parseCitations(message.annotations);
  if (citations.length > 0) completion.citations = citations;
  if (typeof choice.finish_reason === "string") completion.finishReason = choice.finish_reason;
  return completion;
}

function firstChoice(payload: unknown): Record<string, unknown> | undefined {
  const choices = asRecord(payload)?.choices;
  return Array.isArray(choices) ? asRecord(choices[0]) : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function parseCitations(annotations: unknown): LlmUrlCitation[] {
  if (!Array.isArray(annotations)) return [];
  const seen = new Set<string>();
  const citations: LlmUrlCitation[] = [];
  for (const annotation of annotations) {
    const record = asRecord(annotation);
    if (record?.type !== "url_citation") continue;
    const cite = asRecord(record.url_citation) ?? record;
    if (typeof cite.url !== "string" || seen.has(cite.url)) continue;
    seen.add(cite.url);
    const citation: LlmUrlCitation = { url: cite.url };
    if (typeof cite.title === "string" && cite.title) citation.title = cite.title;
    if (typeof cite.content === "string" && cite.content) citation.content = cite.content;
    citations.push(citation);
  }
  return citations;
}

/** OpenRouter can report upstream failures inside a 200 response. */
function embeddedError(payload: unknown): LlmError | undefined {
  const record = asRecord(payload);
  const error = asRecord(record?.error) ?? asRecord(firstChoice(payload)?.error);
  if (!error) return undefined;
  const code = typeof error.code === "number" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message : "unknown error";
  return new LlmError(
    `OpenRouter error${code ? ` ${code}` : ""}: ${message.slice(0, MAX_ERROR_DETAIL_CHARS)}`,
    code,
    code === undefined || isRetryableStatus(code),
  );
}

function errorDetail(payload: unknown): string | undefined {
  const error = asRecord(asRecord(payload)?.error);
  if (!error || typeof error.message !== "string") return undefined;
  const raw = asRecord(error.metadata)?.raw;
  const detail = typeof raw === "string" && raw ? `${error.message} (${raw})` : error.message;
  return detail.slice(0, MAX_ERROR_DETAIL_CHARS);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status !== 501);
}

function retryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 30_000);
  const exponential = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** attempt);
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function abortError(userSignal: AbortSignal | undefined, timeoutMs: number): LlmError {
  return userSignal?.aborted
    ? new LlmError("Request aborted", undefined, false)
    : new LlmError(`Request timed out after ${timeoutMs}ms`, undefined, true);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}
