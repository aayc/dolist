/** Reading a conversation the way a model would: which tools ran, and what came back. */

import { parseJsonObject } from "./text";
import type { BrainMessage, BrainRequest, BrainRole, TurnInfo } from "./types";

/** How a tool result reads to the model. */
export type ResultStatus = "ok" | "error" | "blocked" | "invalid";

export interface CallRecord {
  id: string;
  name: string;
  /** Parsed arguments (undefined when they were not a JSON object). */
  args: Record<string, unknown> | undefined;
  /** Index of the assistant message that made the call. */
  at: number;
  result?: string;
  status?: ResultStatus;
}

export function classifyResult(text: string): ResultStatus {
  const t = text.trimStart();
  if (/^Blocked by safety policy\b/i.test(t)) return "blocked";
  if (
    /^(Validation failed for tool|Tool "?[\w-]+"? not found|Unknown tool\b|Invalid JSON)/i.test(t)
  ) {
    return "invalid";
  }
  if (/^(Error\b|Operation aborted)/i.test(t)) return "error";
  return "ok";
}

export function lastUserIndex(messages: readonly BrainMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return i;
  return -1;
}

export function lastUserText(messages: readonly BrainMessage[]): string {
  const index = lastUserIndex(messages);
  const message = index >= 0 ? messages[index] : undefined;
  return message?.role === "user" ? message.content : "";
}

/** Tool calls made by the assistant from message index `from` on, joined with their results. */
export function collectCalls(messages: readonly BrainMessage[], from = 0): CallRecord[] {
  const calls: CallRecord[] = [];
  const byId = new Map<string, CallRecord>();
  for (let i = Math.max(0, from); i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "assistant") {
      for (const call of message.toolCalls) {
        const record: CallRecord = {
          id: call.id,
          name: call.name,
          args: parseJsonObject(call.arguments),
          at: i,
        };
        calls.push(record);
        byId.set(call.id, record);
      }
    } else if (message.role === "tool") {
      const record = byId.get(message.toolCallId);
      if (record && record.result === undefined) {
        record.result = message.content;
        record.status = classifyResult(message.content);
      }
    }
  }
  return calls;
}

export function detectRole(request: BrainRequest): BrainRole {
  if (request.responseFormat?.type === "json_schema") {
    const judge =
      request.responseFormat.name === "safety_verdict" ||
      request.system.includes("independent safety reviewer");
    return judge ? "judge" : "json";
  }
  if (request.plugins?.some((plugin) => plugin.id === "web")) return "web_search";
  const names = new Set(request.tools.map((tool) => tool.name));
  if (names.has("spawn_subagent") || names.has("post_comment")) return "orchestrator";
  if (names.has("finish_task")) return "subagent";
  return "generic";
}

export function turnInfo(request: BrainRequest, role = detectRole(request)): TurnInfo {
  const index = lastUserIndex(request.messages);
  return {
    role,
    lastUserText: lastUserText(request.messages),
    callsSinceUser: collectCalls(request.messages, index + 1).map((call) => ({
      name: call.name,
      args: call.args,
      ...(call.result !== undefined ? { result: call.result } : {}),
    })),
    toolNames: new Set(request.tools.map((tool) => tool.name)),
  };
}

/** A string argument of a call, if present. */
export function argString(call: CallRecord, key: string): string | undefined {
  const value = call.args?.[key];
  return typeof value === "string" ? value : undefined;
}

/** First line of a tool result (without markdown noise), for summaries. */
export function firstLine(text: string | undefined): string {
  return (
    (text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}
