/**
 * Minimal OpenRouter-compatible chat-completions server for `--offline` smoke runs. It speaks the
 * same wire format (SSE streaming with tool calls and reasoning for Pi, JSON for one-shot calls)
 * and records every request so scripts can check exactly what would be sent to OpenRouter.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: ChatRequest;
}

export interface MockOpenRouter {
  /** Base URL to use instead of https://openrouter.ai/api/v1. */
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

interface ToolCallWire {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: ToolCallWire[];
  tool_call_id?: string;
}

interface ChatRequest {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: Array<{ function: { name: string; parameters: unknown } }>;
  reasoning?: { effort?: string };
  response_format?: { type: string };
  plugins?: Array<{ id: string }>;
  [key: string]: unknown;
}

interface ScriptedTurn {
  reasoning?: string;
  text?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
}

export async function startMockOpenRouter(
  options: { chunkDelayMs?: number } = {},
): Promise<MockOpenRouter> {
  const requests: RecordedRequest[] = [];
  const chunkDelayMs = options.chunkDelayMs ?? 12;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => {
      const body = safeParse(raw);
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res
          .writeHead(404, { "content-type": "application/json" })
          .end('{"error":{"message":"not found","code":404}}');
        return;
      }
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        res
          .writeHead(401, { "content-type": "application/json" })
          .end('{"error":{"message":"No auth","code":401}}');
        return;
      }
      if (body.stream) void streamAgentTurn(res, body, chunkDelayMs);
      else void oneShot(res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Pi (streaming) scenario ──────────────────────────────────────────────────

function nextTurn(body: ChatRequest): ScriptedTurn {
  const messages = body.messages ?? [];
  const results = toolResultsByName(messages);
  const last = messages.at(-1);
  const answeredBefore = messages.some(
    (m) => m.role === "assistant" && !m.tool_calls?.length && m.content,
  );
  if (last?.role === "user" && answeredBefore) {
    const question = textOf(last.content);
    if (/city/i.test(question)) return { text: "I checked the weather in Paris." };
    if (/story/i.test(question))
      return { text: `${"The lighthouse keeper watched the sea. ".repeat(60)}` };
    return { text: `You asked: ${question}` };
  }
  if (last?.role === "user" && /story/i.test(textOf(last.content))) {
    return { text: `${"The lighthouse keeper watched the sea. ".repeat(60)}` };
  }
  if (!results.has("get_weather")) {
    return {
      reasoning:
        "The user wants the Paris weather first, then a bash command, then a deletion attempt.",
      text: "Checking the weather first.",
      toolCall: { name: "get_weather", args: { city: "Paris" } },
    };
  }
  if (!results.has("bash"))
    return { toolCall: { name: "bash", args: { command: "echo hello from bash" } } };
  if (!results.has("delete_everything")) {
    return { toolCall: { name: "delete_everything", args: { confirm: true } } };
  }
  return {
    text: `Weather: ${firstLine(results.get("get_weather"))}. Bash printed "${firstLine(results.get("bash"))}". Deleting everything was refused: ${firstLine(results.get("delete_everything"))}`,
  };
}

async function streamAgentTurn(res: http.ServerResponse, body: ChatRequest, delayMs: number) {
  const turn = nextTurn(body);
  const id = `gen-mock-${Date.now()}`;
  const model = body.model ?? "mock";
  const send = (delta: Record<string, unknown>, finish: string | null = null) =>
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  await sleep(delayMs * 3);
  send({ role: "assistant", content: "" });
  const reasoningEnabled = body.reasoning?.effort !== "none";
  if (turn.reasoning && reasoningEnabled) {
    for (const piece of chunks(turn.reasoning, 24)) {
      send({ reasoning: piece });
      await sleep(delayMs);
    }
  }
  for (const piece of chunks(turn.text ?? "", 8)) {
    if (res.destroyed) return;
    send({ content: piece });
    await sleep(delayMs);
  }
  if (turn.toolCall) {
    const callId = `call_${turn.toolCall.name}_${body.messages?.length ?? 0}`;
    const args = JSON.stringify(turn.toolCall.args);
    send({
      tool_calls: [
        {
          index: 0,
          id: callId,
          type: "function",
          function: { name: turn.toolCall.name, arguments: "" },
        },
      ],
    });
    for (const piece of chunks(args, 10)) {
      send({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
      await sleep(delayMs);
    }
  }
  send({}, turn.toolCall ? "tool_calls" : "stop");
  const promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  const completionTokens =
    Math.ceil(((turn.text ?? "").length + (turn.reasoning ?? "").length) / 4) + 8;
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, cost: 0 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}

// ── One-shot (OpenRouterClient) responses ────────────────────────────────────

async function oneShot(res: http.ServerResponse, body: ChatRequest) {
  const reasoningOff = body.reasoning?.effort === "none";
  // Simulated: reasoning adds latency and tokens, as it does upstream.
  await sleep(reasoningOff ? 40 : 220);
  let content = "pong";
  let annotations: unknown[] | undefined;
  if (body.response_format?.type === "json_schema") {
    content = '{"city":"Paris","temperatureC":21}';
  } else if (body.plugins?.some((p) => p.id === "web")) {
    content = "1. Example Domain — https://example.com — reserved for documentation examples.";
    annotations = [
      {
        type: "url_citation",
        url_citation: {
          url: "https://example.com/",
          title: "Example Domain",
          content: "This domain is for use in documentation examples.",
        },
      },
      {
        type: "url_citation",
        url_citation: {
          url: "https://www.iana.org/help/example-domains",
          title: "IANA example domains",
        },
      },
    ];
  } else {
    const last = textOf(body.messages?.at(-1)?.content);
    content = /arrive/i.test(last) ? "It arrives at 6:15pm." : "pong";
  }
  const completionTokens = Math.ceil(content.length / 4) + (reasoningOff ? 0 : 180);
  const promptTokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      id: `gen-mock-${Date.now()}`,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content, ...(annotations ? { annotations } : {}) },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: { reasoning_tokens: reasoningOff ? 0 : 180 },
        cost: (promptTokens * 0.14 + completionTokens * 0.42) / 1_000_000,
      },
    }),
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function toolResultsByName(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
  }
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id) continue;
    const name = names.get(message.tool_call_id);
    if (name) results.set(name, textOf(message.content));
  }
  return results;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

function firstLine(text: string | undefined): string {
  return (
    (text ?? "")
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function safeParse(raw: string): ChatRequest {
  try {
    return JSON.parse(raw) as ChatRequest;
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
