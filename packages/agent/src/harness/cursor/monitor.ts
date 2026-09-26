/**
 * Defense in depth behind the CLI's deny list. The CLI runs its own tools without asking us, so
 * every tool call it reports is classified, and a built-in tool that produced a result is a
 * violation: the session is stopped. Status can't be trusted for this — a call the deny list
 * blocked is still reported `in_progress` then `completed` — but blocked calls carry no result
 * (nothing, `permissionDenied` or `rejected`), while executed ones do (file content, command
 * output, a diff, match counts…).
 */

import path from "node:path";
import { isRecord } from "@ddl/core";
import { isInside } from "../workspace-guard";
import type { AcpLocation, AcpToolCallUpdate } from "./protocol";

export interface TrackedToolCall {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown[];
  locations?: AcpLocation[];
}

export type WebTool = "web_search" | "web_fetch";

export type ToolCallClass =
  /** A call to our MCP server: the bridge gates it and reports its events. */
  | { type: "bridge" }
  /** CLI bookkeeping without effects outside the agent: todos, questions, modes, subagents. */
  | { type: "internal"; name: string }
  /** The CLI's web search / fetch: allowed only after our permission decision. */
  | { type: "web"; tool: WebTool; value: string }
  /** grep / glob, which the CLI confines to the session's workspace. */
  | { type: "search" }
  /** Another MCP server (the deny list covers the user's configured ones). */
  | { type: "mcp"; server: string; tool: string }
  /** Files, shell, edits, deletes and anything unknown: disabled by the deny list. */
  | { type: "builtin"; label: string };

/** `rawInput._toolName` of the CLI's own tools that have no effect outside the agent. */
const INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  "updateTodos",
  "readTodos",
  "task",
  "askQuestion",
  "createGoal",
  "updateGoal",
  "switchMode",
  "await",
  "createPlan",
  "updatePlan",
]);
const INTERNAL_KINDS: ReadonlySet<string> = new Set(["think", "switch_mode"]);
/** rawOutput fields that describe a refusal or bookkeeping, not a result. */
const NON_RESULT_KEYS: ReadonlySet<string> = new Set([
  "permissionDenied",
  "rejected",
  "reason",
  "error",
  "truncated",
  "durationMs",
  "isBackground",
]);

/** Merges `tool_call` and `tool_call_update` notifications per tool call id. */
export class ToolCallTracker {
  private readonly calls = new Map<string, TrackedToolCall>();

  apply(update: AcpToolCallUpdate): TrackedToolCall {
    const call = this.calls.get(update.toolCallId) ?? { toolCallId: update.toolCallId };
    if (update.kind !== undefined) call.kind = update.kind;
    if (update.title !== undefined) call.title = update.title;
    if (update.status !== undefined) call.status = update.status;
    if (update.rawInput !== undefined && !isEmptyRecord(update.rawInput))
      call.rawInput = update.rawInput;
    if (update.rawOutput !== undefined) call.rawOutput = update.rawOutput;
    if (update.content !== undefined) call.content = update.content;
    if (update.locations !== undefined) call.locations = update.locations;
    this.calls.set(update.toolCallId, call);
    return call;
  }

  get(toolCallId: string): TrackedToolCall | undefined {
    return this.calls.get(toolCallId);
  }

  clear(): void {
    this.calls.clear();
  }
}

export function classifyToolCall(call: TrackedToolCall, serverName: string): ToolCallClass {
  const input = isRecord(call.rawInput) ? call.rawInput : {};
  if (typeof input.providerIdentifier === "string") {
    const tool = typeof input.toolName === "string" ? input.toolName : "";
    return input.providerIdentifier === serverName
      ? { type: "bridge" }
      : { type: "mcp", server: input.providerIdentifier, tool };
  }
  const internal = input._toolName;
  if (typeof internal === "string" && INTERNAL_TOOLS.has(internal)) {
    return { type: "internal", name: internal };
  }
  if (call.kind !== undefined && INTERNAL_KINDS.has(call.kind)) {
    return { type: "internal", name: call.kind };
  }
  const title = call.title ?? "";
  if (
    typeof input.searchTerm === "string" ||
    /^web search\b/i.test(title) ||
    call.toolCallId.startsWith("web_search")
  ) {
    const query = typeof input.searchTerm === "string" ? input.searchTerm : afterColon(title);
    return { type: "web", tool: "web_search", value: query };
  }
  if (call.kind === "fetch") {
    const url = typeof input.url === "string" ? input.url : afterColon(title);
    return { type: "web", tool: "web_fetch", value: url };
  }
  if (call.kind === "search") return { type: "search" };
  return {
    type: "builtin",
    label: `${call.kind ?? "other"}: ${title || "untitled tool"}`.slice(0, 160),
  };
}

/** Evidence that the tool ran: result content, or a rawOutput with a real result in it. */
export function hasResult(call: TrackedToolCall): boolean {
  if (Array.isArray(call.content) && call.content.length > 0) return true;
  const output = call.rawOutput;
  if (output === undefined || output === null) return false;
  if (typeof output === "string") return output.length > 0;
  if (!isRecord(output)) return true;
  return Object.entries(output).some(([key, value]) => {
    if (NON_RESULT_KEYS.has(key)) return false;
    if (/^total|count$/i.test(key))
      return typeof value === "number" ? value > 0 : value !== undefined;
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === "string") return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (isRecord(value)) return Object.keys(value).length > 0;
    return true;
  });
}

export interface MonitorContext {
  /** The session workspace (the CLI's cwd), as given and with symlinks resolved. */
  workspaceRoots: readonly string[];
  isApprovedWeb(call: TrackedToolCall, web: Extract<ToolCallClass, { type: "web" }>): boolean;
}

/** A description of the violation, or undefined when the call is allowed or produced nothing. */
export function findViolation(
  call: TrackedToolCall,
  cls: ToolCallClass,
  ctx: MonitorContext,
): string | undefined {
  switch (cls.type) {
    case "bridge":
    case "internal":
      return undefined;
    case "web":
      if (ctx.isApprovedWeb(call, cls) || !hasResult(call)) return undefined;
      return `${cls.tool === "web_search" ? "web search" : "web fetch"} without the safety gate`;
    case "search": {
      if (!hasResult(call)) return undefined;
      const outside = (call.locations ?? []).find(
        (location) =>
          !ctx.workspaceRoots.some((root) => isInside(root, path.resolve(location.path))),
      );
      return outside ? `search outside its workspace (${outside.path})` : undefined;
    }
    case "mcp":
      return hasResult(call) ? `MCP tool ${cls.server}:${cls.tool || "?"}` : undefined;
    case "builtin":
      return hasResult(call) ? cls.label : undefined;
  }
}

function afterColon(title: string): string {
  const colon = title.indexOf(":");
  return (colon >= 0 ? title.slice(colon + 1) : title).trim().replace(/^"|"$/g, "");
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}
