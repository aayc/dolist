/**
 * A real HTTP server on 127.0.0.1 speaking the subset of OpenRouter's OpenAI-compatible API the app
 * uses — POST /chat/completions (JSON and SSE streaming), GET /key, GET /models — answered by a
 * FakeBrain. Every request is recorded; faults (HTTP errors with Retry-After, malformed bodies,
 * truncated or aborted streams, slow chunks, latency, hangs) can be injected per request.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DEFAULT_MODEL } from "@ddl/core";
import { createFakeBrain, type FakeBrain } from "./brain/brain";
import type { AssistantTurn, BrainRequest } from "./brain/types";
import {
  brainRequestFromChat,
  type CompletionContext,
  chatCompletionBody,
  chatCompletionChunks,
  type WireToolCall,
  wireToolCalls,
  wireUsage,
} from "./wire";

/** Deliberately short and low-entropy so it can never be mistaken for a real key. */
export const FAKE_OPENROUTER_KEY = "ddl-fake-key";

export type FakeEndpoint = "chat" | "key" | "models" | "other";

export type ServerFault =
  /** An HTTP error response, optionally with `Retry-After` (seconds) / `retry-after-ms`. */
  | { kind: "status"; status: number; message?: string; retryAfter?: number; retryAfterMs?: number }
  /** 200 with a body that isn't valid JSON (a broken SSE data line when streaming). */
  | { kind: "malformed-json" }
  /** The stream stops after `afterChunks` chunks and the response ends cleanly (no finish, no [DONE]). */
  | { kind: "truncate"; afterChunks?: number }
  /** The connection is destroyed after `afterChunks` chunks. */
  | { kind: "abort"; afterChunks?: number }
  /** Stream chunks are spaced `chunkDelayMs` apart. */
  | { kind: "slow"; chunkDelayMs: number }
  /** Wait before responding. */
  | { kind: "latency"; ms: number }
  /** Accept the request and never respond (until the client gives up). */
  | { kind: "hang" };

export interface InjectOptions {
  /** How many matching requests the fault applies to. Default 1. */
  times?: number;
  /** Default "chat". */
  endpoint?: FakeEndpoint;
  match?: (request: RecordedRequest) => boolean;
}

export interface RecordedRequest {
  seq: number;
  method: string;
  path: string;
  endpoint: FakeEndpoint;
  /** Lowercased header names. */
  headers: Record<string, string>;
  rawBody: string;
  /** Parsed JSON body (undefined when absent or invalid). */
  body?: unknown;
  stream: boolean;
  authorized: boolean;
  brainRequest?: BrainRequest;
  turn?: AssistantTurn;
  toolCalls: WireToolCall[];
  status?: number;
  fault?: ServerFault["kind"];
  /** The client went away before the response was complete. */
  aborted: boolean;
  /** The response was fully written. */
  completed: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface FakeOpenRouterOptions {
  /** A brain, or a function answering each request. Default: a new `FakeBrain`. */
  brain?: FakeBrain | ((request: BrainRequest) => AssistantTurn);
  apiKey?: string;
  /** GET /key answers 200 when true (default), 401 when false. */
  keyValid?: boolean;
  models?: string[];
  /** Approximate characters per streamed content delta. Default 16. */
  chunkChars?: number;
  /** Delay between stream chunks. Default 0. */
  chunkDelayMs?: number;
  /** Delay before each response. Default 0. */
  latencyMs?: number | ((request: RecordedRequest) => number);
  /** Default "/api/v1" (the base URL is `http://127.0.0.1:<port>/api/v1`). */
  basePath?: string;
  port?: number;
}

export interface FakeOpenRouter {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  /** Use instead of `https://openrouter.ai/api/v1`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The brain answering requests (undefined when a plain function was given). */
  readonly brain: FakeBrain | undefined;
  readonly requests: RecordedRequest[];
  chatRequests(): RecordedRequest[];
  inject(fault: ServerFault, options?: InjectOptions): FakeOpenRouter;
  clearFaults(): void;
  setKeyValid(valid: boolean): void;
  /** Resolves once `count` requests (optionally of one endpoint) have completed or aborted. */
  waitForRequests(
    count: number,
    options?: { endpoint?: FakeEndpoint; timeoutMs?: number },
  ): Promise<void>;
  close(): Promise<void>;
}

interface FaultRule {
  fault: ServerFault;
  remaining: number;
  endpoint: FakeEndpoint;
  match?: (request: RecordedRequest) => boolean;
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

export async function startFakeOpenRouter(
  options: FakeOpenRouterOptions = {},
): Promise<FakeOpenRouter> {
  const brainOption = options.brain ?? createFakeBrain();
  const brain = typeof brainOption === "function" ? undefined : brainOption;
  const decide =
    typeof brainOption === "function" ? brainOption : (r: BrainRequest) => brainOption.decide(r);
  const apiKey = options.apiKey ?? FAKE_OPENROUTER_KEY;
  const basePath = (options.basePath ?? "/api/v1").replace(/\/+$/, "");
  const chunkChars = Math.max(1, options.chunkChars ?? 16);
  const requests: RecordedRequest[] = [];
  const faults: FaultRule[] = [];
  const models = options.models ?? [DEFAULT_MODEL];
  let keyValid = options.keyValid ?? true;
  let completionSeq = 0;
  let toolCallSeq = 0;
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const path = (req.url ?? "/").split("?")[0]!;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      const body = parseJson(rawBody);
      const record: RecordedRequest = {
        seq: requests.length + 1,
        method: req.method ?? "GET",
        path,
        endpoint: endpointOf(req.method ?? "GET", path),
        headers,
        rawBody,
        ...(body !== undefined ? { body } : {}),
        stream: isRecord(body) && body.stream === true,
        authorized: headers.authorization === `Bearer ${apiKey}`,
        toolCalls: [],
        aborted: false,
        completed: false,
        startedAt: Date.now(),
      };
      requests.push(record);
      res.on("close", () => {
        if (!res.writableFinished) record.aborted = true;
        else record.completed = true;
        record.endedAt = Date.now();
        notify();
      });
      handle(record, res).catch((error: unknown) => {
        if (!res.headersSent) {
          sendJson(res, record, 500, {
            error: { message: `Fake server error: ${messageOf(error)}`, code: 500 },
          });
        } else res.destroy();
      });
    });
  });

  async function handle(record: RecordedRequest, res: http.ServerResponse): Promise<void> {
    const fault = takeFault(record);
    if (fault) record.fault = fault.kind;
    const latency =
      typeof options.latencyMs === "function"
        ? options.latencyMs(record)
        : (options.latencyMs ?? 0);
    const extra = fault?.kind === "latency" ? fault.ms : 0;
    if (latency + extra > 0) await sleep(latency + extra, res);
    if (res.destroyed) return;
    if (fault?.kind === "hang") return;
    if (fault?.kind === "status") {
      const headers: Record<string, string> = {};
      if (fault.retryAfter !== undefined) headers["retry-after"] = String(fault.retryAfter);
      if (fault.retryAfterMs !== undefined) headers["retry-after-ms"] = String(fault.retryAfterMs);
      sendJson(
        res,
        record,
        fault.status,
        {
          error: {
            message: fault.message ?? http.STATUS_CODES[fault.status] ?? "Error",
            code: fault.status,
          },
        },
        headers,
      );
      return;
    }
    switch (record.endpoint) {
      case "models":
        sendJson(res, record, 200, { data: models.map(modelInfo) });
        return;
      case "key":
        if (record.authorized && keyValid) {
          sendJson(res, record, 200, {
            data: {
              label: "fake key",
              limit: null,
              usage: 0,
              is_free_tier: false,
              rate_limit: { requests: -1, interval: "10s" },
            },
          });
        } else sendJson(res, record, 401, { error: { message: "User not found.", code: 401 } });
        return;
      case "other":
        sendJson(res, record, 404, {
          error: { message: `Not found: ${record.method} ${record.path}`, code: 404 },
        });
        return;
      case "chat":
        break;
    }
    if (!record.authorized) {
      sendJson(res, record, 401, { error: { message: "User not found.", code: 401 } });
      return;
    }
    if (fault?.kind === "malformed-json" && !record.stream) {
      record.status = 200;
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"id":"gen-broken","choices":[{"message":');
      return;
    }
    if (record.body === undefined || !isRecord(record.body)) {
      sendJson(res, record, 400, {
        error: { message: "The request body is not valid JSON.", code: 400 },
      });
      return;
    }
    const brainRequest = brainRequestFromChat(record.body);
    record.brainRequest = brainRequest;
    const turn = decide(brainRequest);
    record.turn = turn;
    if (turn.hang) return;
    if (turn.error) {
      const status = turn.error.status ?? 500;
      sendJson(res, record, status, { error: { message: turn.error.message, code: status } });
      return;
    }
    const toolCalls = wireToolCalls(turn, () => `call_fake_${++toolCallSeq}`);
    record.toolCalls = toolCalls;
    const usage = brain
      ? brain.usage(brainRequest, turn)
      : {
          promptTokens: Math.ceil(record.rawBody.length / 4),
          completionTokens: Math.ceil((turn.text ?? "").length / 4),
        };
    const ctx: CompletionContext = {
      id: `gen-fake-${++completionSeq}`,
      model: brainRequest.model || models[0]!,
      created: Math.floor(Date.now() / 1000),
      usage: wireUsage(usage.promptTokens, usage.completionTokens, turn.reasoning?.length ?? 0),
      toolCalls,
    };
    const reasoning = brainRequest.reasoning !== "none";
    if (!record.stream) {
      sendJson(res, record, 200, chatCompletionBody(turn, ctx, { reasoning }));
      return;
    }
    await stream(res, record, turn, ctx, reasoning, fault);
  }

  async function stream(
    res: http.ServerResponse,
    record: RecordedRequest,
    turn: AssistantTurn,
    ctx: CompletionContext,
    reasoning: boolean,
    fault: ServerFault | undefined,
  ): Promise<void> {
    record.status = 200;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const delay = fault?.kind === "slow" ? fault.chunkDelayMs : (options.chunkDelayMs ?? 0);
    const chunks = chatCompletionChunks(turn, ctx, { reasoning, chunkChars });
    const stopAfter =
      fault?.kind === "truncate" || fault?.kind === "abort"
        ? Math.max(0, Math.min(fault.afterChunks ?? 2, chunks.length))
        : undefined;
    for (let i = 0; i < chunks.length; i++) {
      if (res.destroyed) return;
      if (stopAfter !== undefined && i >= stopAfter) {
        if (fault?.kind === "abort") res.destroy();
        else res.end();
        return;
      }
      if (fault?.kind === "malformed-json" && i === 1) res.write("data: {this is not json\n\n");
      res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
      if (delay > 0) await sleep(delay, res);
    }
    if (!res.destroyed) res.end("data: [DONE]\n\n");
  }

  function takeFault(record: RecordedRequest): ServerFault | undefined {
    const rule = faults.find(
      (f) => f.remaining > 0 && f.endpoint === record.endpoint && (!f.match || f.match(record)),
    );
    if (!rule) return undefined;
    rule.remaining--;
    return rule.fault;
  }

  function endpointOf(method: string, path: string): FakeEndpoint {
    const relative = path.startsWith(basePath) ? path.slice(basePath.length) : path;
    if (method === "POST" && /\/chat\/completions\/?$/.test(relative)) return "chat";
    if (method === "GET" && /^\/key\/?$|^\/auth\/key\/?$/.test(relative)) return "key";
    if (method === "GET" && /^\/models\/?$/.test(relative)) return "models";
    return "other";
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  let closing: Promise<void> | undefined;

  const handle_: FakeOpenRouter = {
    url,
    baseUrl: `${url}${basePath}`,
    apiKey,
    brain,
    requests,
    chatRequests: () => requests.filter((r) => r.endpoint === "chat"),
    inject(fault, injectOptions = {}) {
      faults.push({
        fault,
        remaining: injectOptions.times ?? 1,
        endpoint: injectOptions.endpoint ?? "chat",
        ...(injectOptions.match ? { match: injectOptions.match } : {}),
      });
      return handle_;
    },
    clearFaults() {
      faults.length = 0;
    },
    setKeyValid(valid) {
      keyValid = valid;
    },
    waitForRequests(count, waitOptions = {}) {
      const done = () =>
        requests.filter(
          (r) =>
            (r.completed || r.aborted) &&
            (!waitOptions.endpoint || r.endpoint === waitOptions.endpoint),
        ).length >= count;
      if (done()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = realSetTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Timed out waiting for ${count} requests (saw ${requests.length})`));
        }, waitOptions.timeoutMs ?? 5_000);
        const check = () => {
          if (!done()) return;
          realClearTimeout(timer);
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
      });
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
  return handle_;
}

function modelInfo(id: string): Record<string, unknown> {
  return {
    id,
    name: `${id} (fake)`,
    context_length: 1_048_576,
    pricing: { prompt: "0.00000014", completion: "0.00000042" },
    top_provider: { max_completion_tokens: 131_072 },
    supported_parameters: [
      "tools",
      "tool_choice",
      "reasoning",
      "response_format",
      "structured_outputs",
    ],
  };
}

function sendJson(
  res: http.ServerResponse,
  record: RecordedRequest,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  record.status = status;
  res
    .writeHead(status, { "content-type": "application/json", ...headers })
    .end(JSON.stringify(body));
}

/** Resolves early when the response is closed (the client went away). */
function sleep(ms: number, res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const timer = realSetTimeout(done, ms);
    function done() {
      realClearTimeout(timer);
      res.off("close", done);
      resolve();
    }
    res.once("close", done);
  });
}

function parseJson(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
