/**
 * Harness abstraction. The harness runs one agent conversation (system prompt + tools + model loop).
 * `PiHarness` embeds the Pi coding-agent SDK; `CursorHarness` drives the Cursor CLI over ACP;
 * `ScriptedHarness` is a deterministic fake used for tests, e2e and `DDL_AGENT_MODE=mock`. Nothing
 * outside `src/harness/` may import Pi or know which harness is in use; `registry.ts` picks one.
 */
import type { ToolResult, ToolSpec } from "@ddl/core";
import type { ShellExecutor } from "../execution/types";

export type AgentRole = "orchestrator" | "subagent";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

export interface ToolCallRequest {
  sessionId: string;
  role: AgentRole;
  toolCallId: string;
  toolName: string;
  input: unknown;
  /**
   * Our spec for custom tools; undefined for harness built-ins (bash/read/write/edit/grep/find/ls)
   * and for tools the Cursor CLI runs itself after asking (web_search/web_fetch).
   */
  spec?: ToolSpec;
}

export type ToolCallDecision = { allow: true } | { allow: false; reason: string };

export type HarnessEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; messageId: string; delta: string }
  | { type: "thinking_delta"; messageId: string; delta: string }
  /** Final text of one assistant message (may be empty when the turn was only tool calls). */
  | { type: "message_end"; messageId: string; text: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool_update"; toolCallId: string; partial: ToolResult }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      result: ToolResult;
      isError: boolean;
      /** True when the safety gate blocked the call. */
      blocked?: boolean;
    }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "error"; message: string }
  /** The agent has settled: no more automatic continuation until the next prompt. */
  | { type: "idle" };

export interface BuiltinToolsOptions {
  /** Expose the harness's file tools (read/write/edit, plus grep/find/ls when readOnly). */
  files: boolean;
  /** Expose a shell tool; commands are executed through this executor (ExecutionProvider). */
  shell?: ShellExecutor;
  /** Only read-only built-ins. */
  readOnly?: boolean;
}

export interface HarnessSessionOptions {
  /** Our identifier (thread id for subagents, `orchestrator:<date>` for the orchestrator). */
  sessionId: string;
  role: AgentRole;
  systemPrompt: string;
  tools: ToolSpec[];
  /** The harness's model id: an OpenRouter id (Pi) or a Cursor CLI model id (Cursor). */
  model: string;
  /** Reasoning effort (Pi). Cursor models carry it in their id's parameters instead. */
  thinking?: ThinkingLevel;
  /** Working directory for file/shell tools (the task workspace). */
  cwd: string;
  builtinTools?: BuiltinToolsOptions;
  /**
   * Called before EVERY tool execution (custom and built-in). This is where the safety gate lives.
   * Must not throw; the harness blocks the call when it returns `{ allow: false }`.
   */
  beforeToolCall: (call: ToolCallRequest) => Promise<ToolCallDecision>;
  onEvent?: (event: HarnessEvent) => void;
  signal?: AbortSignal;
}

export interface HarnessSession {
  readonly id: string;
  readonly isRunning: boolean;
  /**
   * Sends a user message and resolves when the agent settles. If a run is in progress the message
   * is queued as a follow-up and the promise resolves when that follow-up has been handled.
   */
  prompt(text: string): Promise<void>;
  /** A prompt is probably coming (the user is typing): get ready for it, e.g. resume a suspended CLI. */
  warm?(): void;
  /** Inject guidance into the in-flight run (delivered at the next turn boundary). */
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface Harness {
  readonly name: string;
  createSession(options: HarnessSessionOptions): Promise<HarnessSession>;
  /** A session is probably coming soon: prepare for it (never rejects). */
  prewarm?(): Promise<void>;
  /**
   * Releases shared resources (processes, listeners). Sessions still open keep working; the
   * resources close once they have been disposed. No new sessions afterwards.
   */
  dispose?(): Promise<void>;
}
