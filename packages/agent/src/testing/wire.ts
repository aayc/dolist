/**
 * OpenAI-compatible chat-completions wire format, as OpenRouter speaks it: request bodies → the
 * brain's request view, and assistant turns → JSON completions or SSE chunks (role / reasoning /
 * content deltas, tool-call deltas with index, id, name and argument fragments, finish_reason, a
 * usage chunk). Pure; the HTTP fake and the tests share it.
 */
import { isRecord } from "@ddl/core";
import type {
  AssistantTurn,
  BrainMessage,
  BrainRequest,
  BrainTool,
  BrainToolCall,
} from "./brain/types";

export interface WireToolCall {
  id: string;
  name: string;
  /** Exactly what goes on the wire (a JSON string, possibly malformed on purpose). */
  arguments: string;
}

export interface WireUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  prompt_tokens_details: { cached_tokens: number };
  completion_tokens_details: { reasoning_tokens: number };
}

export interface CompletionContext {
  id: string;
  model: string;
  created: number;
  usage: WireUsage;
  toolCalls: WireToolCall[];
}

/** DeepSeek V4.1 Flash list prices (USD per million tokens). */
const INPUT_PER_MTOK = 0.14;
const OUTPUT_PER_MTOK = 0.42;

export function brainRequestFromChat(body: unknown): BrainRequest {
  const record = asRecord(body) ?? {};
  const system: string[] = [];
  const messages: BrainMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const raw of Array.isArray(record.messages) ? record.messages : []) {
    const message = asRecord(raw);
    if (!message) continue;
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = contentText(message.content);
      if (text) system.push(text);
    } else if (role === "user") {
      messages.push({ role: "user", content: contentText(message.content) });
    } else if (role === "assistant") {
      const toolCalls: BrainToolCall[] = [];
      for (const rawCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const call = asRecord(rawCall);
        const fn = asRecord(call?.function);
        if (!call || !fn) continue;
        const id = typeof call.id === "string" ? call.id : "";
        const name = typeof fn.name === "string" ? fn.name : "";
        toolNames.set(id, name);
        toolCalls.push({
          id,
          name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : "",
        });
      }
      const reasoning =
        typeof message.reasoning === "string"
          ? message.reasoning
          : typeof message.reasoning_content === "string"
            ? message.reasoning_content
            : undefined;
      messages.push({
        role: "assistant",
        content: contentText(message.content),
        ...(reasoning ? { reasoning } : {}),
        toolCalls,
      });
    } else if (role === "tool") {
      const toolCallId = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      messages.push({
        role: "tool",
        toolCallId,
        name: toolNames.get(toolCallId) ?? "",
        content: contentText(message.content),
      });
    }
  }
  const tools: BrainTool[] = [];
  for (const rawTool of Array.isArray(record.tools) ? record.tools : []) {
    const fn = asRecord(asRecord(rawTool)?.function);
    if (!fn || typeof fn.name !== "string") continue;
    tools.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters: asRecord(fn.parameters) ?? { type: "object", properties: {} },
    });
  }
  const request: BrainRequest = {
    model: typeof record.model === "string" ? record.model : "",
    system: system.join("\n\n"),
    messages,
    tools,
  };
  const format = asRecord(record.response_format);
  const schema = asRecord(format?.json_schema);
  if (format?.type === "json_schema" && schema) {
    request.responseFormat = {
      type: "json_schema",
      name: typeof schema.name === "string" ? schema.name : "output",
      schema: asRecord(schema.schema) ?? {},
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    };
  }
  if (Array.isArray(record.plugins)) {
    request.plugins = record.plugins.flatMap((raw) => {
      const plugin = asRecord(raw);
      if (!plugin || typeof plugin.id !== "string") return [];
      return [
        {
          id: plugin.id,
          ...(typeof plugin.max_results === "number" ? { max_results: plugin.max_results } : {}),
        },
      ];
    });
  }
  const effort = asRecord(record.reasoning)?.effort;
  if (typeof effort === "string") request.reasoning = effort;
  const maxTokens = record.max_tokens ?? record.max_completion_tokens;
  if (typeof maxTokens === "number") request.maxTokens = maxTokens;
  if (typeof record.temperature === "number") request.temperature = record.temperature;
  return request;
}

/** Assigns ids and serializes arguments (strings are sent verbatim). */
export function wireToolCalls(turn: AssistantTurn, nextId: () => string): WireToolCall[] {
  return (turn.toolCalls ?? []).map((call) => ({
    id: call.id ?? nextId(),
    name: call.name,
    arguments:
      typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
  }));
}

export function wireUsage(
  promptTokens: number,
  completionTokens: number,
  reasoningChars = 0,
): WireUsage {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cost: Number(
      ((promptTokens * INPUT_PER_MTOK + completionTokens * OUTPUT_PER_MTOK) / 1_000_000).toFixed(
        10,
      ),
    ),
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: Math.ceil(reasoningChars / 4) },
  };
}

export function finishReason(turn: AssistantTurn, toolCalls: readonly WireToolCall[]): string {
  return turn.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
}

/** A non-streaming `chat.completion` body. */
export function chatCompletionBody(
  turn: AssistantTurn,
  ctx: CompletionContext,
  options: { reasoning: boolean },
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: turn.text ?? "" };
  if (options.reasoning && turn.reasoning) message.reasoning = turn.reasoning;
  if (ctx.toolCalls.length > 0) {
    message.tool_calls = ctx.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (turn.citations && turn.citations.length > 0) {
    message.annotations = turn.citations.map((citation) => ({
      type: "url_citation",
      url_citation: {
        url: citation.url,
        ...(citation.title ? { title: citation.title } : {}),
        ...(citation.content ? { content: citation.content } : {}),
      },
    }));
  }
  return {
    id: ctx.id,
    object: "chat.completion",
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, message, finish_reason: finishReason(turn, ctx.toolCalls) }],
    usage: ctx.usage,
  };
}

/**
 * `chat.completion.chunk` objects for a streamed turn: role, reasoning deltas (when enabled),
 * content deltas, tool-call deltas (id + name first, then argument fragments), the finish chunk
 * and, last, the usage chunk. The caller writes each as `data: <json>` and ends with `[DONE]`.
 */
export function chatCompletionChunks(
  turn: AssistantTurn,
  ctx: CompletionContext,
  options: { reasoning: boolean; chunkChars: number },
): Array<Record<string, unknown>> {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const out: Array<Record<string, unknown>> = [chunk({ role: "assistant", content: "" })];
  if (options.reasoning && turn.reasoning) {
    for (const piece of splitText(turn.reasoning, options.chunkChars))
      out.push(chunk({ reasoning: piece }));
  }
  for (const piece of splitText(turn.text ?? "", options.chunkChars))
    out.push(chunk({ content: piece }));
  ctx.toolCalls.forEach((call, index) => {
    out.push(
      chunk({
        tool_calls: [
          { index, id: call.id, type: "function", function: { name: call.name, arguments: "" } },
        ],
      }),
    );
    for (const piece of splitRaw(call.arguments, Math.max(4, options.chunkChars))) {
      out.push(chunk({ tool_calls: [{ index, function: { arguments: piece } }] }));
    }
  });
  out.push(chunk({}, finishReason(turn, ctx.toolCalls)));
  out.push({
    id: ctx.id,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.model,
    choices: [],
    usage: ctx.usage,
  });
  return out;
}

/** Word-aligned pieces of roughly `size` characters (a word longer than that is split). */
export function splitText(text: string, size: number): string[] {
  if (!text) return [];
  const words = text.split(/(?<=\s)/);
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + word.length > size) {
      out.push(current);
      current = "";
    }
    if (word.length > size) {
      out.push(...splitRaw(word, size));
      continue;
    }
    current += word;
  }
  if (current) out.push(current);
  return out;
}

function splitRaw(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const record = asRecord(part);
      if (record?.type === "text" && typeof record.text === "string") return record.text;
      if (record?.type === "image_url" || record?.type === "image") return "[image]";
      return "";
    })
    .join("");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
