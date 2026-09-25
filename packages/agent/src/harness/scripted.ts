/**
 * Deterministic harness for tests, evals and `DDL_AGENT_MODE=mock`. A script plays the role of the
 * model: it can stream text and call tools. Tool calls go through `beforeToolCall` exactly like the
 * real harness, so the safety gate and approval flow are exercised end to end.
 */
import { createId, errorResult, type ToolResult, type ToolSpec } from "@ddl/core";
import type {
  AgentRole,
  Harness,
  HarnessEvent,
  HarnessSession,
  HarnessSessionOptions,
} from "./types";

export interface ScriptContext {
  sessionId: string;
  role: AgentRole;
  systemPrompt: string;
  tools: readonly ToolSpec[];
  /** The user message that started this run. */
  message: string;
  /** 0 for the first prompt of the session, then 1, 2, … */
  turn: number;
  signal: AbortSignal;
  /** Streams text as deltas followed by `message_end`. */
  say(text: string): Promise<void>;
  /** Streams reasoning as `thinking_delta`s (what a model's thinking looks like to the host). */
  think(text: string): Promise<void>;
  /**
   * Calls a tool through `beforeToolCall` (the safety gate) and executes it if allowed.
   * Blocked calls resolve with `blocked: true` and an error result, like a real model would see.
   */
  callTool(name: string, input: unknown): Promise<ScriptToolOutcome>;
  /**
   * Steering messages received since the run started, removed from the queue (like Pi delivering
   * them at the next turn boundary). Messages a script doesn't take re-run it after it ends.
   */
  takeSteering(): string[];
}

export interface ScriptToolOutcome {
  result: ToolResult;
  blocked: boolean;
  reason?: string;
  /** The id the call carried through the gate and the harness events. */
  toolCallId: string;
}

export type AgentScript = (ctx: ScriptContext) => Promise<void>;

export interface ScriptedHarnessOptions {
  /** Script used for every session. */
  script?: AgentScript;
  /** Picks a script per session (e.g. by role). Takes precedence over `script`. */
  scriptFor?: (options: HarnessSessionOptions) => AgentScript;
  /** Delay between streamed words, to make streaming visible in the UI. Default 0. */
  wordDelayMs?: number;
}

export class ScriptedHarness implements Harness {
  readonly name = "scripted";
  private readonly options: ScriptedHarnessOptions;

  constructor(options: ScriptedHarnessOptions) {
    this.options = options;
  }

  async createSession(options: HarnessSessionOptions): Promise<HarnessSession> {
    const script = this.options.scriptFor?.(options) ?? this.options.script ?? (async () => {});
    return new ScriptedSession(options, script, this.options.wordDelayMs ?? 0);
  }
}

class ScriptedSession implements HarnessSession {
  readonly id: string;
  private readonly options: HarnessSessionOptions;
  private readonly script: AgentScript;
  private readonly wordDelayMs: number;
  private running = false;
  private turn = 0;
  private controller = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private readonly steering: string[] = [];
  private disposed = false;

  constructor(options: HarnessSessionOptions, script: AgentScript, wordDelayMs: number) {
    this.id = options.sessionId;
    this.options = options;
    this.script = script;
    this.wordDelayMs = wordDelayMs;
  }

  get isRunning(): boolean {
    return this.running;
  }

  prompt(text: string): Promise<void> {
    const run = this.queue.then(() => this.run(text));
    this.queue = run.catch(() => {});
    return run;
  }

  async steer(text: string): Promise<void> {
    if (this.running) this.steering.push(text);
    else await this.prompt(text);
  }

  async abort(): Promise<void> {
    this.controller.abort(new Error("aborted"));
    this.controller = new AbortController();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.abort();
  }

  /** Steering messages received during the current run (scripts may read them via the message). */
  private drainSteering(): string[] {
    return this.steering.splice(0, this.steering.length);
  }

  private emit(event: HarnessEvent): void {
    this.options.onEvent?.(event);
  }

  private async run(message: string): Promise<void> {
    if (this.disposed) return;
    this.running = true;
    const signal = this.controller.signal;
    const turn = this.turn++;
    this.emit({ type: "turn_start" });
    const ctx: ScriptContext = {
      sessionId: this.options.sessionId,
      role: this.options.role,
      systemPrompt: this.options.systemPrompt,
      tools: this.options.tools,
      message,
      turn,
      signal,
      say: (text) => this.say(text, signal),
      think: (text) => this.think(text, signal),
      callTool: (name, input) => this.callTool(name, input, signal),
      takeSteering: () => this.drainSteering(),
    };
    try {
      await this.script(ctx);
      for (const extra of this.drainSteering()) {
        await this.script({ ...ctx, message: extra, turn: this.turn++ });
      }
    } catch (error) {
      if (!signal.aborted) this.emit({ type: "error", message: errorMessage(error) });
    } finally {
      this.running = false;
      this.emit({ type: "idle" });
    }
  }

  private async say(text: string, signal: AbortSignal): Promise<void> {
    const messageId = createId("msg");
    const words = text.split(/(?<=\s)/);
    for (const word of words) {
      if (signal.aborted) throw signal.reason;
      this.emit({ type: "text_delta", messageId, delta: word });
      if (this.wordDelayMs > 0) await new Promise((r) => setTimeout(r, this.wordDelayMs));
    }
    this.emit({ type: "message_end", messageId, text });
  }

  private async think(text: string, signal: AbortSignal): Promise<void> {
    const messageId = createId("msg");
    for (const word of text.split(/(?<=\s)/)) {
      if (signal.aborted) throw signal.reason;
      this.emit({ type: "thinking_delta", messageId, delta: word });
      if (this.wordDelayMs > 0) await new Promise((r) => setTimeout(r, this.wordDelayMs));
    }
  }

  private async callTool(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ScriptToolOutcome> {
    if (signal.aborted) throw signal.reason;
    const toolCallId = createId("call");
    const spec = this.options.tools.find((t) => t.name === name);
    this.emit({ type: "tool_start", toolCallId, toolName: name, input });
    const decision = await this.options.beforeToolCall({
      sessionId: this.options.sessionId,
      role: this.options.role,
      toolCallId,
      toolName: name,
      input,
      ...(spec ? { spec } : {}),
    });
    if (!decision.allow) {
      const result = errorResult(`Blocked by safety policy: ${decision.reason}`);
      this.emit({
        type: "tool_end",
        toolCallId,
        toolName: name,
        result,
        isError: true,
        blocked: true,
      });
      return { result, blocked: true, reason: decision.reason, toolCallId };
    }
    if (!spec) {
      const result = errorResult(`Unknown tool: ${name}`);
      this.emit({ type: "tool_end", toolCallId, toolName: name, result, isError: true });
      return { result, blocked: false, toolCallId };
    }
    try {
      const result = await spec.execute(input, {
        toolCallId,
        signal,
        onUpdate: (partial) => this.emit({ type: "tool_update", toolCallId, partial }),
      });
      this.emit({
        type: "tool_end",
        toolCallId,
        toolName: name,
        result,
        isError: !!result.isError,
      });
      return { result, blocked: false, toolCallId };
    } catch (error) {
      const result = errorResult(errorMessage(error));
      this.emit({ type: "tool_end", toolCallId, toolName: name, result, isError: true });
      return { result, blocked: false, toolCallId };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
