/**
 * Fallback policies for requests that aren't the orchestrator, a subagent, the judge or web search:
 * schema-valid structured output, calling the tools a user message names (with arguments taken
 * from `name=value` pairs and backticks), and plain replies.
 */
import { synthesizeJson } from "../json-schema";
import { excerpt, parseJsonObject } from "./text";
import { collectCalls, firstLine, lastUserIndex, lastUserText } from "./transcript";
import type { AssistantTurn, BrainRequest } from "./types";

export function jsonTurn(request: BrainRequest): AssistantTurn {
  const schema = request.responseFormat?.schema ?? { type: "object" };
  return { text: JSON.stringify(synthesizeJson(schema)) };
}

export function genericTurn(request: BrainRequest): AssistantTurn {
  const index = lastUserIndex(request.messages);
  const prompt = lastUserText(request.messages);
  const calls = collectCalls(request.messages, index + 1);
  const called = new Set(calls.map((call) => call.name));
  const mentioned = request.tools
    .map((tool) => ({ tool, at: mentionIndex(prompt, tool.name) }))
    .filter((entry) => entry.at >= 0 && !called.has(entry.tool.name))
    .sort((a, b) => a.at - b.at);
  const next = mentioned[0];
  if (next) {
    return {
      toolCalls: [
        {
          name: next.tool.name,
          arguments: synthesizeJson(next.tool.parameters, argumentHints(prompt)),
        },
      ],
    };
  }
  if (calls.length > 0) {
    const parts = calls.map(
      (call) => `${call.name}: ${excerpt(firstLine(call.result), 100) || "no output"}`,
    );
    return { text: `Done. ${parts.join("; ")}.` };
  }
  const exact = /reply with exactly the word:?\s*["“]?([\w-]+)/i.exec(prompt);
  if (exact) return { text: exact[1]! };
  if (/\b(story|essay|poem)\b/i.test(prompt)) return { text: longText(prompt) };
  return { text: prompt.trim() ? `You said: ${excerpt(prompt, 200)}` : "Hello." };
}

function mentionIndex(prompt: string, name: string): number {
  const match = new RegExp(
    `(^|[^\\w])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`,
  ).exec(prompt);
  return match ? match.index : -1;
}

/** `key=value` / `key: value` pairs and the first backticked snippet (as `command`). */
function argumentHints(prompt: string): Record<string, unknown> {
  const hints: Record<string, unknown> = {};
  for (const match of prompt.matchAll(/\b([a-zA-Z_][\w]*)\s*=\s*("[^"]*"|[^\s,.;]+)/g)) {
    const raw = match[2]!;
    const parsed = raw.startsWith('"') ? parseJsonObject(`{"v":${raw}}`)?.v : coerce(raw);
    hints[match[1]!] = parsed;
  }
  const code = /`([^`]+)`/.exec(prompt);
  if (code && hints.command === undefined) hints.command = code[1];
  return hints;
}

function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function longText(prompt: string): string {
  const topic = /about (?:a |an |the )?([^.?!]+)/i.exec(prompt)?.[1]?.trim() ?? "the sea";
  const sentences = [
    `There was once a quiet place known for ${topic}.`,
    "Every evening the light changed slowly, and nobody hurried.",
    "People came and went, each carrying a story of their own.",
    "The seasons turned, and the small routines held everything together.",
  ];
  return Array.from({ length: 16 }, (_, i) => sentences[i % sentences.length]).join(" ");
}
