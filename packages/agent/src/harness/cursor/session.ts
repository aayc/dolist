/**
 * HarnessSession over one ACP session of the Cursor CLI. Prompts go through one drain loop (the
 * CLI takes one prompt at a time). ACP can't add a message to a running turn, so steering is
 * delivered at the next turn boundary as a follow-up prompt within the same run — as are the
 * outcomes of tool calls that outlived their MCP request (see ToolRunner). One `turn_start` …
 * `idle` bracket per run, like the Pi harness.
 *
 * Every tool call the CLI reports is checked by the policy monitor; a disabled built-in that
 * produced a result stops the session. Idle sessions are suspended (the CLI process tree ends)
 * and resumed with `session/load` on the next prompt; a CLI that died is resumed the same way.
 */
import {
  type Deferred,
  deferred,
  errorMessage,
  errorResult,
  isRecord,
  type Logger,
  type ToolResult,
  type ToolSpec,
  textResult,
  toolResultText,
} from "@ddl/core";
import { renderTranscript } from "../transcript";
import type { HarnessEvent, HarnessSession, HarnessSessionOptions } from "../types";
import {
  AcpClosedError,
  type AcpConnection,
  type AcpConnectionOptions,
  AcpRpcError,
  METHOD_NOT_FOUND,
} from "./acp";
import { MessageMapper } from "./events";
import type { McpRegistration } from "./mcp-bridge";
import { resolveCursorModel } from "./model";
import {
  classifyToolCall,
  findViolation,
  type ToolCallClass,
  ToolCallTracker,
  type TrackedToolCall,
  type WebTool,
} from "./monitor";
import { routePermission } from "./permissions";
import {
  ACP_PROTOCOL_VERSION,
  type AcpHttpMcpServer,
  type AcpPermissionOutcome,
  type AcpToolCallUpdate,
  CANCELLED_PERMISSION,
  parseInitializeResult,
  parseModels,
  parsePermissionRequest,
  parseSessionResult,
  parseSessionUpdate,
  parseStopReason,
  permissionOutcome,
} from "./protocol";
import { type CallOutcome, ToolRunner } from "./tool-runner";
import { trackAcpSession } from "./workspace";

type ConnectionHandlers = Pick<AcpConnectionOptions, "onNotification" | "onRequest" | "onExit">;

/** A CLI that is already running and initialized (see `CursorHarness.prewarm`). */
export interface WarmCli {
  conn: AcpConnection;
  canResume: boolean;
  images: boolean;
}

/** The ACP handshake, and the checks that this CLI can run our sessions. */
export async function initializeCli(
  conn: AcpConnection,
  timeoutMs: number,
): Promise<{ canResume: boolean; images: boolean }> {
  const init = parseInitializeResult(
    await conn.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "daily-do-list", version: "0.1.0" },
      },
      { timeoutMs },
    ),
  );
  if (init.protocolVersion !== ACP_PROTOCOL_VERSION) {
    throw new Error(
      `The Cursor CLI speaks ACP version ${init.protocolVersion}, not ${ACP_PROTOCOL_VERSION}; update the harness or the CLI (\`agent update\`)`,
    );
  }
  if (!init.mcpHttp) {
    throw new Error(
      "This Cursor CLI can't connect to HTTP MCP servers; update it with `agent update`",
    );
  }
  return { canResume: init.loadSession, images: init.images };
}

type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface CursorSessionInit {
  options: HarnessSessionOptions;
  tools: readonly ToolSpec[];
  builtinNames: ReadonlySet<string>;
  serverName: string;
  /** The CLI's cwd: our AGENTS.md and project config, not the task workspace. */
  workspace: string;
  /** `workspace` as given and with symlinks resolved. */
  workspaceRoots: readonly string[];
  webAllowed: boolean;
  spawn: (handlers: ConnectionHandlers) => AcpConnection;
  idleTimeoutMs: number;
  detachAfterMs: number;
  requestTimeoutMs: number;
  /** How long a cancelled turn may take to end before the CLI is stopped. */
  cancelGraceMs: number;
  logger: Logger;
  /** Releases the harness resources of the session (endpoint, directories, transcript). */
  onClose: (acpSessionId: string | undefined) => Promise<void>;
}

interface PendingPrompt {
  text: string;
  done: Deferred<void>;
}

interface WebApproval {
  tool: WebTool;
  value: string;
  toolCallId: string;
  bound: boolean;
  done: boolean;
}

export class CursorHarnessSession implements HarnessSession {
  readonly id: string;
  /** Serves the session's tools on its MCP endpoint. */
  readonly tools: ToolRunner;
  private readonly init: CursorSessionInit;
  private readonly logger: Logger;
  private readonly mapper = new MessageMapper();
  private readonly tracker = new ToolCallTracker();
  private readonly pending: PendingPrompt[] = [];
  private readonly steering: string[] = [];
  private readonly webApprovals: WebApproval[] = [];
  private readonly boundWeb = new Map<string, WebApproval>();
  private readonly wakers = new Set<() => void>();
  private mcpServer: AcpHttpMcpServer | undefined;
  private conn: AcpConnection | undefined;
  private connecting: Promise<AcpConnection> | undefined;
  private acpSessionId: string | undefined;
  private modelId = "";
  private canResume = false;
  /** The CLI's agent takes images (from the ACP handshake). */
  private images = true;
  private loading = false;
  private draining = false;
  private drained: Promise<void> = Promise.resolve();
  private turnActive = false;
  private runSeq = 0;
  private abortedRunSeq = -1;
  private forcedStop = false;
  private closed = false;
  private stopped: string | undefined;
  private suspendTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelTimer: ReturnType<typeof setTimeout> | undefined;
  private disposing: Promise<void> | undefined;
  /** The transcript this session was created with, as text, until the first prompt carries it. */
  private restored: string | undefined;

  constructor(init: CursorSessionInit) {
    this.init = init;
    this.id = init.options.sessionId;
    this.logger = init.logger;
    if (init.options.transcript?.length) this.restored = renderTranscript(init.options.transcript);
    this.tools = new ToolRunner({
      sessionId: init.options.sessionId,
      role: init.options.role,
      tools: init.tools,
      builtinNames: init.builtinNames,
      beforeToolCall: init.options.beforeToolCall,
      detachAfterMs: init.detachAfterMs,
      images: () => this.images,
      logger: init.logger,
      emit: (event) => {
        if (event.type === "tool_start") this.emitAll(this.mapper.flush());
        this.emit(event);
      },
    });
    init.options.signal?.addEventListener("abort", this.onSignalAbort, { once: true });
  }

  get isRunning(): boolean {
    return this.draining;
  }

  /**
   * Starts the CLI (or takes over a warm one), creates the ACP session with our MCP endpoint and
   * selects the model.
   */
  async start(endpoint: Pick<McpRegistration, "url" | "token">, warm?: WarmCli): Promise<void> {
    this.mcpServer = {
      type: "http",
      name: this.init.serverName,
      url: endpoint.url,
      headers: [{ name: "Authorization", value: `Bearer ${endpoint.token}` }],
    };
    let conn: AcpConnection;
    if (warm) {
      conn = warm.conn;
      conn.bind(this.handlers(() => conn));
    } else {
      conn = this.spawn();
    }
    try {
      if (warm) ({ canResume: this.canResume, images: this.images } = warm);
      else await this.initialize(conn);
      const created = parseSessionResult(
        await conn.request(
          "session/new",
          { cwd: this.init.workspace, mcpServers: [this.mcpServer] },
          { timeoutMs: this.init.requestTimeoutMs },
        ),
      );
      this.acpSessionId = created.sessionId;
      trackAcpSession(created.sessionId);
      const model = resolveCursorModel(this.init.options.model, created.models.availableModels);
      this.modelId = model.modelId;
      if (model.presetFor) {
        this.logger.warn(
          "The Cursor CLI's agent mode can't run this model variant; using its preset",
          {
            configured: model.presetFor,
            running: model.modelId,
          },
        );
      }
      if (created.models.currentModelId !== this.modelId) {
        await conn.request(
          "session/set_model",
          { sessionId: created.sessionId, modelId: this.modelId },
          { timeoutMs: this.init.requestTimeoutMs },
        );
      }
      this.conn = conn;
    } catch (error) {
      await conn.close(0);
      throw new Error(describeError(error));
    }
    this.logger.debug("Cursor session created", { model: this.modelId, resumable: this.canResume });
  }

  prompt(text: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const done = deferred<void>();
    // ACP can't seed a new session with messages, so a restored conversation leads the first prompt.
    const restored = this.restored;
    this.restored = undefined;
    this.pending.push({ text: restored ? `${restored}\n\n${text}` : text, done });
    this.kick();
    return done.promise;
  }

  async steer(text: string): Promise<void> {
    if (this.closed) return;
    if (!this.draining) return this.prompt(text);
    this.steering.push(text);
    this.wake();
  }

  async abort(): Promise<void> {
    if (this.closed) return;
    this.abortedRunSeq = this.runSeq;
    this.steering.length = 0;
    this.tools.abortAll();
    this.wake();
    const conn = this.conn;
    if (!this.turnActive || !conn || !this.acpSessionId) return;
    conn.notify("session/cancel", { sessionId: this.acpSessionId });
    this.cancelTimer ??= setTimeout(() => {
      this.cancelTimer = undefined;
      if (!this.turnActive || this.conn !== conn) return;
      this.logger.warn("The Cursor CLI did not stop the cancelled turn; stopping the CLI");
      this.forcedStop = true;
      this.conn = undefined;
      void conn.close(0);
    }, this.init.cancelGraceMs);
  }

  /**
   * Gets a suspended session's CLI running again before its next prompt arrives (the user started
   * typing) and restarts the idle countdown; resuming takes seconds.
   */
  warm(): void {
    if (this.closed) return;
    if (this.conn && !this.conn.closed) {
      if (!this.draining) this.scheduleSuspend();
      return;
    }
    if (!this.canResume || !this.acpSessionId) return;
    this.connection().then(
      () => {
        if (!this.draining) this.scheduleSuspend();
      },
      (error: unknown) => {
        this.logger.debug("Couldn't warm the Cursor session", { error: describeError(error) });
      },
    );
  }

  dispose(): Promise<void> {
    this.disposing ??= this.close();
    return this.disposing;
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  private kick(): void {
    if (this.draining || this.closed) return;
    this.draining = true;
    clearTimeout(this.suspendTimer);
    this.drained = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const next = this.closed ? undefined : this.pending.shift();
        if (!next) return;
        const failure = await this.run(next.text);
        const settled = this.pending.length === 0;
        if (settled) this.draining = false;
        if (failure) next.done.reject(failure);
        else next.done.resolve();
        if (settled) return;
      }
    } finally {
      this.draining = false;
      this.scheduleSuspend();
    }
  }

  /** Resolves with the error when the prompt couldn't be run; turn errors arrive as events. */
  private async run(text: string): Promise<Error | undefined> {
    const seq = ++this.runSeq;
    this.forcedStop = false;
    this.emit({ type: "turn_start" });
    try {
      if (this.stopped) throw new Error(this.stopped);
      if (this.abortedRunSeq === seq) return undefined;
      const conn = await this.connection();
      const blocks = this.blocks([text]);
      await this.turns(conn, blocks.length > 0 ? blocks : [{ type: "text", text }], seq);
      return undefined;
    } catch (error) {
      const message = describeError(error);
      this.logger.warn("Cursor prompt failed", { error: message });
      this.emit({ type: "error", message });
      return error instanceof Error ? error : new Error(message);
    } finally {
      this.emitAll(this.mapper.flush());
      this.settleWebApprovals();
      this.tracker.clear();
      this.emit({ type: "idle" });
    }
  }

  private async turns(conn: AcpConnection, first: PromptBlock[], seq: number): Promise<void> {
    let blocks = first;
    for (;;) {
      if (this.closed || this.abortedRunSeq === seq || !this.acpSessionId) return;
      let stopReason: string;
      this.turnActive = true;
      try {
        stopReason = parseStopReason(
          await conn.request("session/prompt", { sessionId: this.acpSessionId, prompt: blocks }),
        );
      } catch (error) {
        if (this.closed || this.stopped !== undefined || this.forcedStop) return;
        const message =
          error instanceof AcpClosedError
            ? `${error.message}. The session resumes with your next message.`
            : describeError(error);
        this.emit({ type: "error", message });
        return;
      } finally {
        this.turnActive = false;
        clearTimeout(this.cancelTimer);
        this.cancelTimer = undefined;
        this.emitAll(this.mapper.flush());
      }
      if (stopReason === "cancelled" || this.abortedRunSeq === seq) return;
      if (stopReason === "refusal") {
        this.emit({ type: "error", message: "The Cursor model refused to continue." });
        return;
      }
      const next = await this.followUp(seq);
      if (!next) return;
      blocks = next;
    }
  }

  /** Steering and finished detached calls for the next turn; waits while calls are running. */
  private async followUp(seq: number): Promise<PromptBlock[] | undefined> {
    for (;;) {
      if (this.closed || this.stopped !== undefined || this.abortedRunSeq === seq) return undefined;
      const steering = this.steering.splice(0);
      const blocks = this.blocks(steering);
      if (blocks.length > 0) return blocks;
      if (this.tools.pendingCount === 0) return undefined;
      await Promise.race([
        this.tools.whenFinished(),
        new Promise<void>((resolve) => this.wakers.add(resolve)),
      ]);
    }
  }

  /** Prompt content: outcomes of detached calls that finished, then the given messages. */
  private blocks(texts: readonly string[]): PromptBlock[] {
    const blocks: PromptBlock[] = this.tools.takeFinished().flatMap(outcomeBlocks);
    for (const text of texts) if (text.trim()) blocks.push({ type: "text", text });
    return blocks;
  }

  private wake(): void {
    for (const resolve of this.wakers) resolve();
    this.wakers.clear();
  }

  // ── Connection ────────────────────────────────────────────────────────────

  private spawn(): AcpConnection {
    const conn: AcpConnection = this.init.spawn(this.handlers(() => conn));
    return conn;
  }

  private async initialize(conn: AcpConnection): Promise<void> {
    ({ canResume: this.canResume, images: this.images } = await initializeCli(
      conn,
      this.init.requestTimeoutMs,
    ));
  }

  private handlers(conn: () => AcpConnection): ConnectionHandlers {
    return {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: (exit) => this.onExit(conn(), exit.signal ?? exit.code),
    };
  }

  private connection(): Promise<AcpConnection> {
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
    this.connecting ??= this.resume().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async resume(): Promise<AcpConnection> {
    if (!this.canResume || !this.acpSessionId || !this.mcpServer) {
      throw new Error("The Cursor CLI session has ended and this CLI can't resume it");
    }
    const conn = this.spawn();
    try {
      await this.initialize(conn);
      this.loading = true;
      let loaded: unknown;
      try {
        loaded = await conn.request(
          "session/load",
          { sessionId: this.acpSessionId, cwd: this.init.workspace, mcpServers: [this.mcpServer] },
          { timeoutMs: this.init.requestTimeoutMs },
        );
      } finally {
        this.loading = false;
      }
      const models = parseModels(isRecord(loaded) ? loaded.models : undefined);
      if (models.currentModelId !== this.modelId) {
        await conn.request(
          "session/set_model",
          { sessionId: this.acpSessionId, modelId: this.modelId },
          { timeoutMs: this.init.requestTimeoutMs },
        );
      }
    } catch (error) {
      await conn.close(0);
      throw new Error(`Couldn't resume the Cursor session: ${describeError(error)}`);
    }
    this.conn = conn;
    this.logger.debug("Cursor session resumed");
    return conn;
  }

  /** Only the active connection matters: suspended, replaced or stopped ones exit on purpose. */
  private onExit(conn: AcpConnection, how: string | number | null): void {
    if (this.conn !== conn) return;
    this.conn = undefined;
    if (!this.closed) this.logger.warn("The Cursor CLI exited unexpectedly", { exit: how });
  }

  private scheduleSuspend(): void {
    clearTimeout(this.suspendTimer);
    if (this.closed || !this.canResume || this.init.idleTimeoutMs <= 0) return;
    this.suspendTimer = setTimeout(() => void this.suspend(), this.init.idleTimeoutMs);
    this.suspendTimer.unref?.();
  }

  private async suspend(): Promise<void> {
    const conn = this.conn;
    if (this.draining || this.closed || !conn) return;
    this.conn = undefined;
    await conn.close();
    this.logger.debug("Cursor session suspended while idle");
  }

  // ── What the CLI sends ────────────────────────────────────────────────────

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || this.loading || !this.acpSessionId) return;
    const update = parseSessionUpdate(params, this.acpSessionId);
    if (!update) return;
    switch (update.type) {
      case "agent_message_chunk":
        this.emitAll(this.mapper.textDelta(update.text));
        break;
      case "agent_thought_chunk":
        this.emitAll(this.mapper.thinkingDelta(update.text));
        break;
      case "tool_call":
        this.emitAll(this.mapper.flush());
        this.onToolCall(update.call);
        break;
      case "tool_call_update":
        this.onToolCall(update.call);
        break;
      default:
        break;
    }
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.onPermission(params);
      case "cursor/update_todos":
      case "cursor/task":
        return {};
      default:
        throw new AcpRpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private onToolCall(update: AcpToolCallUpdate): void {
    const call = this.tracker.apply(update);
    const cls = classifyToolCall(call, this.init.serverName);
    if (cls.type === "web") this.bindWebApproval(call, cls);
    const violation = findViolation(call, cls, {
      workspaceRoots: this.init.workspaceRoots,
      isApprovedWeb: (tracked) => this.boundWeb.has(tracked.toolCallId),
    });
    if (violation) {
      this.stopForPolicy(violation);
      return;
    }
    if (cls.type === "web" && isTerminal(call.status)) this.finishWebCall(call);
    if (cls.type === "builtin" && isTerminal(call.status)) {
      this.logger.debug("The Cursor CLI refused one of its built-in tools", { tool: cls.label });
    }
  }

  private async onPermission(params: unknown): Promise<AcpPermissionOutcome> {
    const request = parsePermissionRequest(params);
    if (!request || request.sessionId !== this.acpSessionId) return CANCELLED_PERMISSION;
    if (this.closed || this.stopped !== undefined) return permissionOutcome(request, false);
    const route = routePermission(request, (toolCallId) => {
      const call = this.tracker.get(toolCallId);
      return call !== undefined && classifyToolCall(call, this.init.serverName).type === "bridge";
    });
    switch (route.type) {
      case "bridge":
        return permissionOutcome(request, true);
      case "reject":
        this.logger.debug("Rejected a permission request from the Cursor CLI", {
          request: route.what,
        });
        return permissionOutcome(request, false);
      case "web": {
        if (!this.init.webAllowed) {
          this.tools.refuseBuiltin(
            route.tool,
            route.input,
            "web access isn't part of this agent's task",
          );
          return permissionOutcome(request, false);
        }
        const { toolCallId, allowed } = await this.tools.gateBuiltin(route.tool, route.input);
        if (!allowed || this.closed || this.stopped !== undefined)
          return permissionOutcome(request, false);
        this.webApprovals.push({
          tool: route.tool,
          value: route.value,
          toolCallId,
          bound: false,
          done: false,
        });
        return permissionOutcome(request, true);
      }
    }
  }

  /** Links the CLI's web tool call to the approval we gave for it (the ids differ). */
  private bindWebApproval(
    call: TrackedToolCall,
    web: Extract<ToolCallClass, { type: "web" }>,
  ): void {
    if (this.boundWeb.has(call.toolCallId)) return;
    const open = this.webApprovals.filter((a) => !a.bound && a.tool === web.tool);
    const approval = open.find((a) => a.value === web.value.trim()) ?? open[0];
    if (!approval) return;
    approval.bound = true;
    this.boundWeb.set(call.toolCallId, approval);
  }

  private finishWebCall(call: TrackedToolCall): void {
    const approval = this.boundWeb.get(call.toolCallId);
    if (!approval || approval.done) return;
    approval.done = true;
    this.tools.completeBuiltin(approval.toolCallId, approval.tool, webResult(call, approval));
  }

  private settleWebApprovals(): void {
    for (const approval of this.webApprovals) {
      if (approval.done) continue;
      approval.done = true;
      this.tools.completeBuiltin(
        approval.toolCallId,
        approval.tool,
        errorResult("The web request didn't run"),
      );
    }
    this.webApprovals.length = 0;
    this.boundWeb.clear();
  }

  private stopForPolicy(violation: string): void {
    if (this.stopped !== undefined || this.closed) return;
    this.stopped = `Cursor ran a built-in tool that this harness disables (${violation}); the session was stopped`;
    this.logger.warn("Cursor ran a disabled built-in tool; stopping the session", {
      tool: violation,
    });
    this.emitAll(this.mapper.flush());
    this.emit({ type: "error", message: this.stopped });
    this.tools.abortAll();
    this.wake();
    const conn = this.conn;
    this.conn = undefined;
    if (conn && this.acpSessionId) {
      conn.notify("session/cancel", { sessionId: this.acpSessionId });
      void conn.close(0);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private readonly onSignalAbort = (): void => {
    void this.dispose();
  };

  private async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.suspendTimer);
    clearTimeout(this.cancelTimer);
    this.init.options.signal?.removeEventListener("abort", this.onSignalAbort);
    for (const item of this.pending.splice(0)) item.done.resolve();
    this.steering.length = 0;
    this.tools.close();
    this.wake();
    const conn = this.conn;
    this.conn = undefined;
    try {
      if (conn) {
        if (this.turnActive && this.acpSessionId) {
          conn.notify("session/cancel", { sessionId: this.acpSessionId });
        }
        await conn.close();
      }
      await this.drained;
    } catch (error) {
      this.logger.warn("error while closing the Cursor session", { error: describeError(error) });
    } finally {
      await this.init.onClose(this.acpSessionId).catch((error: unknown) => {
        this.logger.warn("couldn't clean up the Cursor session", { error: describeError(error) });
      });
    }
  }

  private emit(event: HarnessEvent): void {
    try {
      this.init.options.onEvent?.(event);
    } catch (error) {
      this.logger.warn("onEvent listener threw", {
        event: event.type,
        error: describeError(error),
      });
    }
  }

  private emitAll(events: readonly HarnessEvent[]): void {
    for (const event of events) this.emit(event);
  }
}

function isTerminal(status: string | undefined): boolean {
  return status === "completed" || status === "failed";
}

function webResult(call: TrackedToolCall, approval: WebApproval): ToolResult {
  const output = isRecord(call.rawOutput) ? call.rawOutput : {};
  if (output.rejected === true || call.status === "failed") {
    return errorResult(
      typeof output.reason === "string" ? output.reason : "The web request failed",
    );
  }
  if (approval.tool === "web_search") {
    const count = typeof output.referenceCount === "number" ? output.referenceCount : undefined;
    return textResult(
      count === undefined
        ? "Cursor searched the web"
        : `Cursor's web search returned ${count} result(s)`,
      { query: approval.value, via: "cursor" },
    );
  }
  return textResult(`Cursor fetched ${approval.value}`, { url: approval.value, via: "cursor" });
}

function outcomeBlocks(outcome: CallOutcome): PromptBlock[] {
  const text = toolResultText(outcome.result).trim();
  const header = outcome.blocked
    ? `[${outcome.toolName} (call ${outcome.toolCallId}), which was still running earlier, was not carried out]`
    : `[Result of ${outcome.toolName} (call ${outcome.toolCallId}), which was still running earlier${outcome.result.isError ? " — it failed" : ""}]`;
  const blocks: PromptBlock[] = [{ type: "text", text: text ? `${header}\n${text}` : header }];
  for (const part of outcome.result.content) {
    if (part.type === "image")
      blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
  }
  return blocks;
}

export function describeError(error: unknown): string {
  if (error instanceof AcpRpcError) {
    const detail = typeof error.data === "string" && error.data ? ` (${error.data})` : "";
    if (error.code === -32000 || /\b(auth|login|sign.?in)/i.test(error.message)) {
      return `The Cursor CLI is not signed in or its login expired: ${error.message}${detail}. Run \`agent login\` in a terminal.`;
    }
    return `Cursor: ${error.message}${detail}`;
  }
  return errorMessage(error);
}
