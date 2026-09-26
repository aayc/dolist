/**
 * ToolSpec ⇄ Pi ToolDefinition adapter, result conversion, and the approval guard wrapped around
 * every tool handed to Pi (custom and built-in).
 */
import {
  isRecord,
  type Logger,
  type ToolContent,
  type ToolResult,
  type ToolSpec,
  toolResultText,
} from "@ddl/core";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { ToolCallLedger } from "./ledger";
import { normalizeToolSchema } from "./schema";

// biome-ignore lint/suspicious/noExplicitAny: Pi's own registry type for heterogeneous definitions.
export type AnyToolDefinition = ToolDefinition<any, any, any>;

export class ToolNotApprovedError extends Error {
  constructor(toolName: string, toolCallId: string) {
    super(`Tool call ${toolCallId} (${toolName}) was not approved by the safety gate`);
    this.name = "ToolNotApprovedError";
  }
}

/** Carries a ToolSpec's `isError` result through Pi, which only treats thrown errors as failures. */
export class ToolResultError extends Error {
  readonly result: ToolResult;

  constructor(result: ToolResult) {
    super(errorTextForModel(result));
    this.name = "ToolResultError";
    this.result = result;
  }
}

export interface SpecAdapterOptions {
  ledger: ToolCallLedger;
  logger?: Logger;
  /** The session's model takes image input (Pi's catalog: `model.input`). */
  images?: boolean;
}

export function toolSpecToDefinition(
  spec: ToolSpec,
  options: SpecAdapterOptions,
): ToolDefinition<TSchema, unknown> {
  const { schema, warnings, degraded } = normalizeToolSchema(spec.parameters);
  if (warnings.length > 0) {
    options.logger?.warn("tool schema normalized", { tool: spec.name, warnings, degraded });
  }
  const { ledger } = options;
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: schema as TSchema,
    // Side-effecting calls in one model turn run one at a time (e.g. browser clicks).
    executionMode: spec.safety.readOnly ? "parallel" : "sequential",
    async execute(toolCallId, params, signal, onUpdate) {
      const result = await spec.execute(params, {
        toolCallId,
        ...(signal ? { signal } : {}),
        ...(onUpdate ? { onUpdate: (partial) => onUpdate(toAgentToolResult(partial)) } : {}),
        ...(options.images !== undefined ? { images: options.images } : {}),
      });
      ledger.recordResult(toolCallId, result);
      if (result.isError) throw new ToolResultError(result);
      return toAgentToolResult(result);
    },
  };
}

/** Refuses to run a call the safety gate has not approved (defense in depth for the gate hook). */
export function guardDefinition<T extends AnyToolDefinition>(
  definition: T,
  ledger: ToolCallLedger,
): T {
  return {
    ...definition,
    execute: (toolCallId, params, signal, onUpdate, ctx) => {
      if (!ledger.consumeApproval(toolCallId)) {
        return Promise.reject(new ToolNotApprovedError(definition.name, toolCallId));
      }
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export function toAgentToolResult(result: ToolResult): AgentToolResult<unknown> {
  return {
    content: result.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image", data: part.data, mimeType: part.mimeType },
    ),
    details: result.details,
  };
}

/** Converts a Pi tool result (typed `any` in Pi's events) into our ToolResult. */
export function toToolResult(value: unknown, isError: boolean): ToolResult {
  const record = isRecord(value) ? value : {};
  const content: ToolContent[] = Array.isArray(record.content)
    ? record.content.flatMap((part): ToolContent[] => {
        if (!isRecord(part)) return [];
        if (part.type === "text" && typeof part.text === "string") {
          return [{ type: "text", text: part.text }];
        }
        if (
          part.type === "image" &&
          typeof part.data === "string" &&
          typeof part.mimeType === "string"
        ) {
          return [{ type: "image", data: part.data, mimeType: part.mimeType }];
        }
        return [];
      })
    : [];
  const result: ToolResult = { content };
  if (record.details !== undefined && record.details !== null) result.details = record.details;
  if (isError) result.isError = true;
  return result;
}

/** OpenAI-style tool messages have no error flag, so the text itself must say it failed. */
function errorTextForModel(result: ToolResult): string {
  const text = toolResultText(result).trim();
  if (!text) return "Error: the tool reported a failure without details";
  return /^error\b/i.test(text) ? text : `Error: ${text}`;
}
