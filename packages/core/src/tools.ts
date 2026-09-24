/**
 * Harness-agnostic tool contract. Built-in tools, MCP connector tools and execution-provider tools
 * are all expressed as `ToolSpec`s; the harness adapter (Pi today) converts them at the edge, and
 * the safety gate wraps every one of them. Nothing outside `packages/agent/src/harness` should know
 * which agent harness is in use.
 */
import type { ActionCategory } from "./agent-types";

/** A JSON Schema object describing a tool's input (draft 2020-12 subset, `type: "object"`). */
export type JsonSchema = { [key: string]: unknown };

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult<D = unknown> {
  content: ToolContent[];
  /** Structured data for UIs/logs; not shown to the model. */
  details?: D;
  /** A failure the model should see and react to (thrown errors are infrastructure failures). */
  isError?: boolean;
}

/**
 * Declarative safety metadata. The safety evaluator combines these hints with pattern rules and an
 * LLM judge; hints can only make a call *more* restricted, never bypass the rules.
 */
export interface ToolSafetyHints {
  /** Never changes anything outside the agent's own scratch space. */
  readOnly?: boolean;
  /** May delete/overwrite data or have irreversible effects. */
  destructive?: boolean;
  /** Touches the outside world (network requests with side effects, other people). */
  openWorld?: boolean;
  /** Primary effect category. */
  category?: ActionCategory;
  /** Always require human approval, regardless of other signals. */
  alwaysRequireApproval?: boolean;
  /** Human-readable one-liner for approval cards, e.g. `Send email to sam@example.com`. */
  describe?(input: unknown): string;
}

export interface ToolExecutionContext {
  toolCallId: string;
  signal?: AbortSignal;
  /** Stream partial results (e.g. long-running shell output). */
  onUpdate?: (partial: ToolResult) => void;
  taskId?: string | null;
  threadId?: string | null;
}

export interface ToolSpec<I = unknown, D = unknown> {
  /** Must match `TOOL_NAME_RE` (OpenAI-compatible function name). */
  name: string;
  label: string;
  description: string;
  parameters: JsonSchema;
  safety: ToolSafetyHints;
  /** Extra usage guidance appended to the system prompt when the tool is enabled. */
  promptGuidelines?: string[];
  execute(input: I, ctx: ToolExecutionContext): Promise<ToolResult<D>>;
}

export const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function textResult<D = unknown>(text: string, details?: D): ToolResult<D> {
  return details === undefined
    ? { content: [{ type: "text", text }] }
    : { content: [{ type: "text", text }], details };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Concatenated text content of a tool result (images omitted). */
export function toolResultText(result: ToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
