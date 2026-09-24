/**
 * Runs one session's tool calls for the MCP bridge the way the Pi harness does: arguments are
 * validated, then the safety gate decides (failing closed), then the ToolSpec runs, with
 * tool_start / tool_update / tool_end events. Side-effecting calls run one at a time in arrival
 * order; read-only ones run in parallel.
 *
 * The CLI's MCP client gives up on a request after 60 s, and a call can take much longer (above
 * all when it waits for the user's approval). A call still running after `detachAfterMs` is
 * answered with a "still running" note and finishes in the background; the session delivers its
 * outcome to the model in a follow-up message.
 */
import {
  createId,
  errorResult,
  type Logger,
  type ToolResult,
  type ToolSpec,
  toolResultText,
} from "@ddl/core";
import { validateJson } from "../../tools/json-schema";
import { decideGate } from "../gate-decision";
import type { AgentRole, HarnessEvent, ToolCallDecision, ToolCallRequest } from "../types";
import type { McpSessionHandler, McpTool, McpToolResult } from "./mcp-bridge";

export interface CallOutcome {
  toolCallId: string;
  toolName: string;
  result: ToolResult;
  blocked: boolean;
}

export interface ToolRunnerOptions {
  sessionId: string;
  role: AgentRole;
  tools: readonly ToolSpec[];
  /** Built-in tools: the gate gets no spec for them (it applies its built-in rules). */
  builtinNames: ReadonlySet<string>;
  beforeToolCall: (call: ToolCallRequest) => Promise<ToolCallDecision>;
  emit: (event: HarnessEvent) => void;
  detachAfterMs: number;
  logger: Logger;
}

interface RunningCall {
  toolCallId: string;
  promise: Promise<CallOutcome>;
  abort(): void;
}

export class ToolRunner implements McpSessionHandler {
  private readonly options: ToolRunnerOptions;
  private readonly tools: Map<string, ToolSpec>;
  private readonly detached = new Map<string, Promise<CallOutcome>>();
  private readonly finished: CallOutcome[] = [];
  private readonly waiters = new Set<() => void>();
  private sequential: Promise<unknown> = Promise.resolve();
  private controller = new AbortController();
  private closed = false;

  constructor(options: ToolRunnerOptions) {
    this.options = options;
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  listTools(): McpTool[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));
  }

  async callTool(name: string, args: unknown, requestSignal: AbortSignal): Promise<McpToolResult> {
    const call = this.start(name, args);
    const onCancel = () => call.abort();
    if (requestSignal.aborted) call.abort();
    else requestSignal.addEventListener("abort", onCancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"detach">((resolve) => {
      timer = setTimeout(() => resolve("detach"), this.options.detachAfterMs);
    });
    try {
      const first = await Promise.race([call.promise, deadline]);
      if (first !== "detach") return toMcpResult(first.result);
      this.detached.set(call.toolCallId, call.promise);
      void call.promise.then((outcome) => {
        this.detached.delete(call.toolCallId);
        this.finished.push(outcome);
        this.wake();
      });
      return {
        content: [
          {
            type: "text",
            text: `${name} is still running (it may be waiting for the user's approval). Don't call it again: end your turn now. Its result will be sent to you in a follow-up message as soon as it finishes.`,
          },
        ],
      };
    } finally {
      clearTimeout(timer);
      requestSignal.removeEventListener("abort", onCancel);
    }
  }

  /**
   * Gate decision for a tool the CLI runs itself (its web search and fetch), with the same
   * tool_start and, when blocked, tool_end events. The caller reports completion with
   * `completeBuiltin`.
   */
  async gateBuiltin(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ toolCallId: string; allowed: boolean }> {
    const toolCallId = createId("call");
    this.options.emit({ type: "tool_start", toolCallId, toolName, input });
    const decision = await this.decide(
      toolCallId,
      toolName,
      input,
      undefined,
      this.controller.signal,
    );
    if (decision.allow) return { toolCallId, allowed: true };
    this.options.emit({
      type: "tool_end",
      toolCallId,
      toolName,
      result: errorResult(`Blocked by safety policy: ${decision.reason}`),
      isError: true,
      blocked: true,
    });
    return { toolCallId, allowed: false };
  }

  completeBuiltin(toolCallId: string, toolName: string, result: ToolResult): void {
    this.options.emit({
      type: "tool_end",
      toolCallId,
      toolName,
      result,
      isError: !!result.isError,
    });
  }

  /** Reports a CLI tool refused without asking the gate (the session lacks the capability). */
  refuseBuiltin(toolName: string, input: Record<string, unknown>, reason: string): void {
    const toolCallId = createId("call");
    this.options.emit({ type: "tool_start", toolCallId, toolName, input });
    this.options.emit({
      type: "tool_end",
      toolCallId,
      toolName,
      result: errorResult(`Blocked: ${reason}`),
      isError: true,
      blocked: true,
    });
  }

  /** Calls answered with "still running" that haven't finished yet. */
  get pendingCount(): number {
    return this.detached.size;
  }

  /** Outcomes of detached calls that finished since the last call, for delivery to the model. */
  takeFinished(): CallOutcome[] {
    return this.finished.splice(0);
  }

  /** Resolves when a detached call finishes. */
  whenFinished(): Promise<void> {
    if (this.finished.length > 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add(resolve));
  }

  /** Aborts every running call (detached ones included); later calls run normally. */
  abortAll(): void {
    this.controller.abort();
    this.controller = new AbortController();
  }

  /** Refuses every later call and aborts the running ones. */
  close(): void {
    this.closed = true;
    this.abortAll();
    this.wake();
  }

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  private start(name: string, args: unknown): RunningCall {
    const toolCallId = createId("call");
    const controller = new AbortController();
    const session = this.controller.signal;
    const onSessionAbort = () => controller.abort();
    if (session.aborted) controller.abort();
    else session.addEventListener("abort", onSessionAbort, { once: true });
    const promise = this.run(toolCallId, name, args, controller.signal).finally(() =>
      session.removeEventListener("abort", onSessionAbort),
    );
    return { toolCallId, promise, abort: () => controller.abort() };
  }

  private async run(
    toolCallId: string,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    const { emit } = this.options;
    const input = args ?? {};
    const spec = this.tools.get(name);
    const problem = !spec
      ? `Unknown tool: ${name}`
      : validateJson(spec.parameters, input).slice(0, 5).join("; ");
    emit({ type: "tool_start", toolCallId, toolName: name, input });
    if (!spec || problem) {
      const result = errorResult(spec ? `Invalid arguments for ${name}: ${problem}` : problem);
      emit({ type: "tool_end", toolCallId, toolName: name, result, isError: true });
      return { toolCallId, toolName: name, result, blocked: false };
    }
    const execute = () => this.gateAndExecute(toolCallId, spec, input, signal);
    return spec.safety.readOnly ? execute() : this.serialize(execute);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.sequential.then(task, task);
    this.sequential = run.catch(() => {});
    return run;
  }

  private async gateAndExecute(
    toolCallId: string,
    spec: ToolSpec,
    input: unknown,
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    const { emit } = this.options;
    const toolName = spec.name;
    const builtin = this.options.builtinNames.has(toolName);
    const decision = await this.decide(
      toolCallId,
      toolName,
      input,
      builtin ? undefined : spec,
      signal,
    );
    if (!decision.allow) {
      const result = errorResult(`Blocked by safety policy: ${decision.reason}`);
      emit({ type: "tool_end", toolCallId, toolName, result, isError: true, blocked: true });
      return { toolCallId, toolName, result, blocked: true };
    }
    let result: ToolResult;
    if (signal.aborted) {
      result = errorResult("The tool call was cancelled");
    } else {
      try {
        result = await spec.execute(input, {
          toolCallId,
          signal,
          onUpdate: (partial) => emit({ type: "tool_update", toolCallId, partial }),
        });
      } catch (error) {
        result = errorResult(error instanceof Error ? error.message : String(error));
      }
    }
    emit({ type: "tool_end", toolCallId, toolName, result, isError: !!result.isError });
    return { toolCallId, toolName, result, blocked: false };
  }

  private decide(
    toolCallId: string,
    toolName: string,
    input: unknown,
    spec: ToolSpec | undefined,
    signal: AbortSignal,
  ): Promise<ToolCallDecision> {
    if (this.closed)
      return Promise.resolve({ allow: false, reason: "the agent session was closed" });
    const request: ToolCallRequest = {
      sessionId: this.options.sessionId,
      role: this.options.role,
      toolCallId,
      toolName,
      input,
      ...(spec ? { spec } : {}),
    };
    return decideGate(this.options.beforeToolCall, request, signal, this.options.logger);
  }
}

function toMcpResult(result: ToolResult): McpToolResult {
  const content: McpToolResult["content"] = result.content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", data: part.data, mimeType: part.mimeType },
  );
  if (result.isError && !toolResultText(result).trim()) {
    content.push({ type: "text", text: "Error: the tool reported a failure without details" });
  }
  return result.isError ? { content, isError: true } : { content };
}
