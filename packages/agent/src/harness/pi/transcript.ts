/**
 * Restores a conversation into a new Pi session: each transcript entry becomes a message in the
 * session's history (user prompts, assistant messages with their tool calls, tool results), so
 * the model continues the same conversation instead of reading a summary of it.
 */
import type {
  Api,
  AssistantMessage,
  JsonObject,
  Message,
  Model,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TranscriptEntry } from "../types";

const NO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function seedTranscript(
  sessionManager: SessionManager,
  transcript: readonly TranscriptEntry[],
  model: Model<Api>,
  now: number,
): void {
  for (const entry of transcript) sessionManager.appendMessage(toPiMessage(entry, model, now));
}

export function toPiMessage(entry: TranscriptEntry, model: Model<Api>, now: number): Message {
  switch (entry.role) {
    case "user":
      return { role: "user", content: entry.text, timestamp: now };
    case "assistant": {
      const message: AssistantMessage = {
        role: "assistant",
        content: [
          ...(entry.text ? [{ type: "text" as const, text: entry.text }] : []),
          ...entry.toolCalls.map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: asArguments(call.input),
          })),
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: NO_USAGE,
        stopReason: entry.toolCalls.length > 0 ? "toolUse" : "stop",
        timestamp: now,
      };
      return message;
    }
    case "tool": {
      const message: ToolResultMessage = {
        role: "toolResult",
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        content: [{ type: "text", text: entry.output }],
        isError: entry.isError,
        timestamp: now,
      };
      return message;
    }
  }
}

function asArguments(input: unknown): JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as JsonObject)
    : {};
}
