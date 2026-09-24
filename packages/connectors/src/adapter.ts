/**
 * MCP tool → harness-agnostic `ToolSpec`. Specs are thin handles: execution and the approval posture
 * are resolved through a `McpToolTarget` at call time, so a config reload (tightened approval,
 * removed server, changed filter) takes effect even for specs already handed to running sessions.
 *
 * Safety hints follow the MCP spec's annotation semantics and defaults:
 *   readOnly    = readOnlyHint === true                 (default false)
 *   destructive = !readOnly && destructiveHint !== false (default true; meaningless when read-only)
 *   openWorld   = openWorldHint !== false                (default true)
 * Annotations come from the server and are untrusted: they only feed the safety evaluator, which
 * still applies its rules and judge to every call.
 */
import type { ToolExecutionContext, ToolResult, ToolSafetyHints, ToolSpec } from "@ddl/core";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ApprovalPosture } from "./config";
import type { McpProgress } from "./connection";
import { type McpToolResultDetails, projectCallToolResult } from "./content";
import { isSensitiveKey, MASK, maskSecrets } from "./redact";
import { normalizeInputSchema } from "./schema";
import {
  type McpToolAnnotations,
  type McpToolDefinition,
  sanitizeToolText,
} from "./tool-definition";
import { isPlainObject } from "./util";

const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_SERVER_DESCRIPTION_CHARS = 200;
const MAX_LABEL_CHARS = 100;
const MAX_DESCRIBE_CHARS = 240;
const MAX_ARG_STRING_CHARS = 60;
const MAX_LISTED_ITEMS = 3;

export interface McpToolTarget {
  /** Current approval posture of the server; `undefined` once it was removed or disabled. */
  approval(): ApprovalPosture | undefined;
  call(
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; onProgress?: (progress: McpProgress) => void },
  ): Promise<unknown>;
}

export interface McpToolSpecOptions {
  /** Model-facing name from `assignToolNames`. */
  name: string;
  serverName: string;
  serverDescription?: string | undefined;
  tool: McpToolDefinition;
  target: McpToolTarget;
}

export interface McpSafetyHints {
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
}

export function safetyHintsFromAnnotations(annotations: McpToolAnnotations): McpSafetyHints {
  const readOnly = annotations.readOnlyHint === true;
  return {
    readOnly,
    destructive: !readOnly && annotations.destructiveHint !== false,
    openWorld: annotations.openWorldHint !== false,
  };
}

/** `always`: every call; `writes`: every call not annotated read-only; gone servers fail closed. */
export function requiresApproval(posture: ApprovalPosture | undefined, readOnly: boolean): boolean {
  if (posture === undefined) return true;
  return posture === "always" || (posture === "writes" && !readOnly);
}

export function createMcpToolSpec(
  options: McpToolSpecOptions,
): ToolSpec<unknown, McpToolResultDetails> {
  const { name, serverName, tool, target } = options;
  const hints = safetyHintsFromAnnotations(tool.annotations);
  const safety: ToolSafetyHints = {
    readOnly: hints.readOnly,
    destructive: hints.destructive,
    openWorld: hints.openWorld,
    get alwaysRequireApproval() {
      return requiresApproval(target.approval(), hints.readOnly);
    },
    describe: (input) => describeMcpCall(serverName, tool.name, input),
  };
  return {
    name,
    label: sanitizeToolText(tool.annotations.title ?? tool.title ?? tool.name, MAX_LABEL_CHARS),
    description: toolDescription(serverName, options.serverDescription, tool),
    parameters: normalizeInputSchema(tool.inputSchema),
    safety,
    async execute(
      input: unknown,
      ctx: ToolExecutionContext,
    ): Promise<ToolResult<McpToolResultDetails>> {
      const details: McpToolResultDetails = { server: serverName, tool: tool.name };
      const args = input === undefined || input === null ? {} : input;
      if (!isPlainObject(args)) {
        return {
          content: [{ type: "text", text: "Tool arguments must be a JSON object." }],
          details,
          isError: true,
        };
      }
      const onUpdate = ctx.onUpdate;
      try {
        const raw = await target.call(args, {
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(onUpdate
            ? {
                onProgress: (progress: McpProgress) =>
                  onUpdate({ content: [{ type: "text", text: formatProgress(progress) }] }),
              }
            : {}),
        });
        return projectCallToolResult(raw, { server: serverName, tool: tool.name });
      } catch (error) {
        // A JSON-RPC error from a live server (bad arguments, unknown tool…) is feedback for the
        // model; infrastructure failures are thrown.
        if (error instanceof McpError) {
          // Errors thrown as McpError on the server arrive with the "MCP error <code>: " prefix twice.
          const detail = error.message.replace(/^(?:MCP error -?\d+: )+/, "");
          const text = `MCP server "${serverName}" returned error ${error.code}: ${maskSecrets(detail)}`;
          return { content: [{ type: "text", text }], details, isError: true };
        }
        throw error;
      }
    },
  };
}

/** One-liner for approval cards: `github · create_issue(owner: "acme", title: "Fix login")`. */
export function describeMcpCall(serverName: string, toolName: string, input: unknown): string {
  const args =
    input === undefined || input === null
      ? ""
      : isPlainObject(input)
        ? formatEntries(input, 0)
        : formatValue(input, undefined, 0);
  const line = `${serverName} · ${toolName}(${args})`;
  return line.length <= MAX_DESCRIBE_CHARS ? line : `${line.slice(0, MAX_DESCRIBE_CHARS - 1)}…`;
}

function toolDescription(
  serverName: string,
  serverDescription: string | undefined,
  tool: McpToolDefinition,
): string {
  const body = tool.description ? sanitizeToolText(tool.description, MAX_DESCRIPTION_CHARS) : "";
  const about = serverDescription
    ? `: ${sanitizeToolText(serverDescription, MAX_SERVER_DESCRIPTION_CHARS)}`
    : "";
  return `[${serverName}${about}] ${body || `Tool "${tool.name}" from MCP server "${serverName}".`}`;
}

function formatEntries(record: Record<string, unknown>, depth: number): string {
  const entries = Object.entries(record);
  const shown = depth === 0 ? entries : entries.slice(0, MAX_LISTED_ITEMS);
  const parts = shown.map(([key, value]) => `${key}: ${formatValue(value, key, depth)}`);
  if (shown.length < entries.length) parts.push(`…+${entries.length - shown.length}`);
  return parts.join(", ");
}

function formatValue(value: unknown, key: string | undefined, depth: number): string {
  if (key !== undefined && isSensitiveKey(key) && shouldMask(value, key)) return MASK;
  if (typeof value === "string") {
    const masked = maskSecrets(value);
    const short =
      masked.length > MAX_ARG_STRING_CHARS
        ? `${masked.slice(0, MAX_ARG_STRING_CHARS - 1)}…`
        : masked;
    return JSON.stringify(short);
  }
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    if (depth >= 1) return `[${value.length} items]`;
    const items: unknown[] = value;
    const shown = items
      .slice(0, MAX_LISTED_ITEMS)
      .map((item) => formatValue(item, undefined, depth + 1));
    if (items.length > MAX_LISTED_ITEMS) shown.push(`…+${items.length - MAX_LISTED_ITEMS}`);
    return `[${shown.join(", ")}]`;
  }
  if (!isPlainObject(value)) return "{…}";
  return depth >= 1 ? "{…}" : `{${formatEntries(value, depth + 1)}}`;
}

/** Counts such as `max_tokens` are not secrets; everything else under a credential-like key is. */
function shouldMask(value: unknown, key: string): boolean {
  if (typeof value === "boolean" || value === null || value === undefined) return false;
  return !(typeof value === "number" && /token/i.test(key));
}

function formatProgress({ progress, total, message }: McpProgress): string {
  const amount = total === undefined ? `${progress}` : `${progress}/${total}`;
  return message ? `Progress ${amount}: ${message}` : `Progress ${amount}`;
}
