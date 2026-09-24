/**
 * One MCP server connection: SDK `Client` and transport lifecycle, lenient tool listing, and tool
 * calls with per-call timeouts and cancellation.
 *
 * Recovery: an unexpected disconnect starts background reconnects with jittered exponential backoff
 * (tool calls wait for them within their own timeout). When those are exhausted, or a lazy connect
 * fails, the connection enters `error` and refuses new attempts until a cooldown has passed; the
 * next use after that tries again.
 *
 * Adapted from OpenClaw (MIT): src/agents/mcp-client-lifecycle.ts (connect deadline race, disposal)
 * and Hermes Agent (MIT): tools/mcp_tool_common.py (`_jittered` backoff).
 */
import { type Logger, silentLogger, truncate } from "@ddl/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ErrorCode,
  McpError,
  ResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorTransport } from "./config";
import {
  ConnectorConfigError,
  ConnectorError,
  McpConnectError,
  McpTimeoutError,
  McpTransportError,
  McpUnavailableError,
} from "./errors";
import { maskSecrets } from "./redact";
import { type McpToolDefinition, parseToolDefinition, suspiciousToolText } from "./tool-definition";
import type { TransportHandle, TransportSource } from "./transports";
import { errnoCode, errorMessage, toError } from "./util";

export type ConnectionState = "idle" | "connecting" | "connected" | "error" | "closed";

export interface RetryPolicy {
  /** Background reconnect attempts after an unexpected disconnect. */
  maxReconnectAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Relative jitter applied to each delay (0.2 = ±20%). */
  jitter: number;
  /** How long a failed server is left alone before the next lazy attempt. */
  cooldownMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxReconnectAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.2,
  cooldownMs: 60_000,
};

export const MAX_TOOLS_PER_SERVER = 500;
const MAX_LIST_PAGES = 100;
const CLOSE_TIMEOUT_MS = 5_000;
const TERMINATE_SESSION_TIMEOUT_MS = 2_000;
const TOOLS_REFRESH_DEBOUNCE_MS = 100;
const CLIENT_INFO = { name: "daily-do-list", version: "0.1.0" };

export interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface CallToolOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: McpProgress) => void;
}

export interface McpConnectionOptions {
  serverName: string;
  source: TransportSource;
  connectTimeoutMs: number;
  retry?: Partial<RetryPolicy>;
  logger?: Logger;
  /** Called after any change of state, tools or last error. */
  onChange?: () => void;
  maxTools?: number;
  now?: () => number;
  random?: () => number;
}

interface Session {
  readonly client: Client;
  readonly handle: TransportHandle;
  pid: number | null;
  /** Closed on purpose: close events are expected and must not trigger reconnects. */
  closing: boolean;
  /** The transport reported that it closed. */
  dead: boolean;
  disposal: Promise<void> | undefined;
}

interface Opened {
  session: Session;
  tools: McpToolDefinition[];
}

export class McpConnection {
  readonly serverName: string;
  private readonly source: TransportSource;
  private readonly connectTimeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly logger: Logger;
  private readonly onChange: () => void;
  private readonly maxTools: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly lifetime = new AbortController();

  private currentState: ConnectionState = "idle";
  private session: Session | undefined;
  private tools: McpToolDefinition[] | undefined;
  private failure: Error | undefined;
  private retryAt = 0;
  private negotiated: ConnectorTransport | undefined;
  private connecting: Promise<Session> | undefined;
  private reconnecting: Promise<void> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private closed: Promise<void> | undefined;

  constructor(options: McpConnectionOptions) {
    this.serverName = options.serverName;
    this.source = options.source;
    this.connectTimeoutMs = options.connectTimeoutMs;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.logger = options.logger ?? silentLogger;
    this.onChange = options.onChange ?? (() => undefined);
    this.maxTools = options.maxTools ?? MAX_TOOLS_PER_SERVER;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  /** Why the server is in `error`, or why it is reconnecting. */
  get lastError(): Error | undefined {
    return this.failure;
  }

  get transport(): ConnectorTransport {
    return this.negotiated ?? this.source.kind;
  }

  /** Tools of the current session; while reconnecting, those of the previous one. */
  get toolList(): readonly McpToolDefinition[] | undefined {
    return this.tools;
  }

  stderrTail(count?: number): string[] {
    return this.source.stderrTail(count);
  }

  /** Connects unless already connected, reconnecting in the background, or cooling down. */
  async ready(): Promise<void> {
    if (this.isClosed || this.session || this.reconnecting) return;
    await this.ensureSession().catch(() => undefined);
  }

  /**
   * Calls a tool and returns the raw `CallToolResult`. Waiting for a (re)connection counts against
   * `timeoutMs`. Rejects with the signal's reason when aborted, `McpTimeoutError`,
   * `McpUnavailableError`, `McpTransportError`, or the server's `McpError` for protocol-level errors.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: CallToolOptions,
  ): Promise<unknown> {
    const { signal, timeoutMs } = options;
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new McpTimeoutError(this.serverName, "call_tool", timeoutMs, name)),
      timeoutMs,
    );
    const forwardAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const started = this.now();
    let session: Session | undefined;
    try {
      session = await this.ensureSession(controller.signal);
      const onProgress = options.onProgress;
      return await session.client.request(
        { method: "tools/call", params: { name, arguments: args } },
        ResultSchema,
        {
          signal: controller.signal,
          timeout: Math.max(1, timeoutMs - (this.now() - started)),
          ...(onProgress
            ? {
                onprogress: ({ progress, total, message }) =>
                  onProgress({
                    progress,
                    ...(total !== undefined ? { total } : {}),
                    ...(message !== undefined ? { message } : {}),
                  }),
              }
            : {}),
        },
      );
    } catch (error) {
      // The SDK reports aborts as RequestTimeout errors; the signal knows what really happened.
      if (controller.signal.aborted) throw controller.signal.reason;
      throw this.callError(error, session, name, timeoutMs);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /** Stops everything, including stdio child processes. Idempotent. */
  close(): Promise<void> {
    if (!this.closed) {
      this.lifetime.abort();
      this.currentState = "closed";
      clearTimeout(this.refreshTimer);
      const session = this.session;
      const { connecting, reconnecting } = this;
      this.session = undefined;
      this.tools = undefined;
      this.closed = (async () => {
        if (session) await this.disposeSession(session);
        await connecting?.catch(() => undefined);
        await reconnecting;
      })();
    }
    return this.closed;
  }

  private get isClosed(): boolean {
    return this.lifetime.signal.aborted;
  }

  private ensureSession(signal?: AbortSignal): Promise<Session> {
    if (this.isClosed) return Promise.reject(this.closedError());
    if (this.session) return Promise.resolve(this.session);
    if (this.reconnecting) {
      return abortable(this.reconnecting, signal).then(
        () => this.session ?? Promise.reject(this.unavailableError()),
      );
    }
    if (!this.connecting) {
      if (this.currentState === "error" && this.now() < this.retryAt) {
        return Promise.reject(this.unavailableError());
      }
      this.setState("connecting");
      const attempt = (async () => {
        try {
          return this.adopt(await this.openSession());
        } catch (error) {
          this.enterError(error);
          throw error;
        }
      })();
      const clear = () => {
        if (this.connecting === attempt) this.connecting = undefined;
      };
      attempt.then(clear, clear);
      this.connecting = attempt;
    }
    return abortable(this.connecting, signal);
  }

  private adopt({ session, tools }: Opened): Session {
    if (this.isClosed) {
      void this.disposeSession(session);
      throw this.closedError();
    }
    if (session.dead) {
      void this.disposeSession(session);
      throw new McpConnectError(
        this.serverName,
        `MCP server "${this.serverName}" exited right after starting${this.stderrHint()}`,
      );
    }
    this.session = session;
    this.tools = tools;
    this.failure = undefined;
    this.retryAt = 0;
    this.negotiated = session.handle.kind;
    this.setState("connected");
    return session;
  }

  private enterError(error: unknown): void {
    if (this.isClosed) return;
    this.failure = toError(error);
    this.tools = undefined;
    this.retryAt = this.now() + this.retry.cooldownMs;
    this.logger.warn("MCP server unavailable", {
      error: maskSecrets(this.failure.message),
      retryInMs: this.retry.cooldownMs,
    });
    this.setState("error");
  }

  private setState(state: ConnectionState): void {
    if (this.isClosed) return;
    this.currentState = state;
    this.notify();
  }

  private notify(): void {
    try {
      this.onChange();
    } catch (error) {
      this.logger.warn("connector change listener failed", { error: errorMessage(error) });
    }
  }

  private async openSession(): Promise<Opened> {
    const useSse = this.negotiated === "sse" && this.source.sseFallback;
    try {
      return await this.connectOnce(useSse);
    } catch (error) {
      if (!this.shouldFallBack(error, useSse)) throw error;
      this.logger.info("streamable HTTP rejected; trying legacy SSE", {
        error: maskSecrets(errorMessage(error)),
      });
      try {
        return await this.connectOnce(true);
      } catch (fallbackError) {
        throw new McpConnectError(
          this.serverName,
          `${errorMessage(error)} (legacy SSE fallback also failed: ${errorMessage(fallbackError)})`,
          { cause: fallbackError },
        );
      }
    }
  }

  /** Only a first-ever connection may switch transports, and never for timeouts or auth failures. */
  private shouldFallBack(error: unknown, usedSse: boolean): boolean {
    return (
      this.source.sseFallback &&
      !usedSse &&
      this.negotiated === undefined &&
      !this.isClosed &&
      !(error instanceof McpTimeoutError) &&
      !(error instanceof ConnectorConfigError) &&
      httpStatus(error) !== 401 &&
      httpStatus(error) !== 403
    );
  }

  private async connectOnce(fallback: boolean): Promise<Opened> {
    const handle = await this.source.open({ fallback });
    // Nothing runs yet (stdio spawns inside `connect`), so a close during `open` needs no cleanup.
    if (this.isClosed) throw this.closedError();
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    const session: Session = {
      client,
      handle,
      pid: null,
      closing: false,
      dead: false,
      disposal: undefined,
    };
    client.onclose = () => this.handleClose(session);
    client.onerror = (error) => this.handleTransportError(session, error);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
      this.scheduleToolsRefresh(session),
    );

    const timeoutMs = this.connectTimeoutMs;
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new McpTimeoutError(this.serverName, "connect", timeoutMs)),
      timeoutMs,
    );
    const stop = () => deadline.abort(this.closedError());
    this.lifetime.signal.addEventListener("abort", stop, { once: true });
    try {
      // Raced against the deadline: some transports (e.g. an SSE stream that never sends its
      // endpoint) ignore the request signal while starting.
      await abortable(
        client.connect(handle.transport, { signal: deadline.signal, timeout: timeoutMs }),
        deadline.signal,
      );
      session.pid = handle.pid();
      const tools = await abortable(this.fetchTools(client, deadline.signal), deadline.signal);
      return { session, tools };
    } catch (error) {
      await this.disposeSession(session);
      if (deadline.signal.aborted) throw deadline.signal.reason;
      throw this.connectError(error);
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", stop);
    }
  }

  private async fetchTools(client: Client, signal: AbortSignal): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      let result: Record<string, unknown>;
      try {
        result = await client.request(
          { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
          ResultSchema,
          { signal, timeout: this.connectTimeoutMs },
        );
      } catch (error) {
        if (page === 0 && error instanceof McpError && error.code === ErrorCode.MethodNotFound) {
          return [];
        }
        throw error;
      }
      const entries: unknown[] = Array.isArray(result.tools) ? result.tools : [];
      for (const raw of entries) {
        const parsed = parseToolDefinition(raw);
        if (!parsed.ok) {
          this.logger.warn("skipping MCP tool", { reason: truncate(parsed.reason, 200) });
          continue;
        }
        const { tool } = parsed;
        if (names.has(tool.name)) {
          this.logger.warn("skipping duplicate MCP tool", { tool: truncate(tool.name, 100) });
          continue;
        }
        if (tools.length >= this.maxTools) {
          this.logger.warn("MCP server lists too many tools; ignoring the rest", {
            max: this.maxTools,
          });
          return tools;
        }
        const findings = suspiciousToolText(`${tool.title ?? ""}\n${tool.description ?? ""}`);
        if (findings.length > 0) {
          this.logger.warn("suspicious MCP tool description", { tool: tool.name, findings });
        }
        names.add(tool.name);
        tools.push(tool);
      }
      const next = result.nextCursor;
      if (typeof next !== "string" || next === "") return tools;
      if (cursors.has(next)) {
        this.logger.warn("MCP server repeated a pagination cursor; stopping");
        return tools;
      }
      cursors.add(next);
      cursor = next;
    }
    this.logger.warn("MCP server returned too many tool pages; stopping", {
      pages: MAX_LIST_PAGES,
    });
    return tools;
  }

  private scheduleToolsRefresh(session: Session): void {
    if (this.session !== session) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(
      () => void this.refreshTools(session),
      TOOLS_REFRESH_DEBOUNCE_MS,
    );
    this.refreshTimer.unref();
  }

  private async refreshTools(session: Session): Promise<void> {
    if (this.session !== session) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.connectTimeoutMs);
    try {
      const tools = await this.fetchTools(session.client, controller.signal);
      if (this.session !== session) return;
      this.tools = tools;
      this.logger.info("MCP tool list changed", { tools: tools.length });
      this.notify();
    } catch (error) {
      if (this.session !== session) return;
      this.logger.warn("failed to refresh MCP tool list", {
        error: maskSecrets(errorMessage(error)),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private handleClose(session: Session): void {
    session.dead = true;
    this.lostSession(
      session,
      new McpTransportError(
        this.serverName,
        `MCP server "${this.serverName}" disconnected${this.stderrHint()}`,
      ),
    );
  }

  private handleTransportError(session: Session, error: Error): void {
    if (session.closing || this.session !== session) return;
    this.logger.debug("MCP transport error", { error: maskSecrets(errorMessage(error)) });
    // A legacy SSE stream retries inside EventSource and never reports a close, but its server-side
    // session is gone; closing forces a clean re-initialization.
    if (session.handle.kind === "sse" && error instanceof SseError) {
      session.handle.transport.close().catch(() => undefined);
    }
  }

  private lostSession(session: Session, failure: Error): void {
    if (session.closing || this.session !== session) return;
    this.session = undefined;
    clearTimeout(this.refreshTimer);
    this.failure = failure;
    this.logger.warn("MCP server connection lost; reconnecting", {
      error: maskSecrets(failure.message),
    });
    void this.disposeSession(session);
    this.startReconnect();
  }

  private startReconnect(): void {
    if (this.isClosed || this.reconnecting) return;
    this.setState("connecting");
    const loop = this.reconnectLoop();
    this.reconnecting = loop;
    void loop.then(() => {
      if (this.reconnecting === loop) this.reconnecting = undefined;
    });
  }

  private async reconnectLoop(): Promise<void> {
    let lastError: unknown = this.failure;
    for (let attempt = 0; attempt < this.retry.maxReconnectAttempts; attempt++) {
      try {
        await delay(this.backoffDelay(attempt), this.lifetime.signal);
      } catch {
        return;
      }
      try {
        this.adopt(await this.openSession());
        this.logger.info("MCP server reconnected", { attempt: attempt + 1 });
        return;
      } catch (error) {
        if (this.isClosed) return;
        lastError = error;
        this.failure = toError(error);
        this.logger.warn("MCP reconnect attempt failed", {
          attempt: attempt + 1,
          error: maskSecrets(errorMessage(error)),
        });
        this.notify();
        if (error instanceof ConnectorConfigError) break;
      }
    }
    this.enterError(
      lastError ?? new McpConnectError(this.serverName, `MCP server "${this.serverName}" is down`),
    );
  }

  private backoffDelay(attempt: number): number {
    const { baseDelayMs, maxDelayMs, jitter } = this.retry;
    const base = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    return Math.max(0, Math.round(base * (1 - jitter + this.random() * 2 * jitter)));
  }

  private callError(
    error: unknown,
    session: Session | undefined,
    tool: string,
    timeoutMs: number,
  ): unknown {
    if (error instanceof ConnectorError) return error;
    if (error instanceof McpError) {
      if (error.code === ErrorCode.RequestTimeout) {
        return new McpTimeoutError(this.serverName, "call_tool", timeoutMs, tool);
      }
      if (error.code !== ErrorCode.ConnectionClosed) return error;
      return new McpTransportError(
        this.serverName,
        `MCP server "${this.serverName}" disconnected while running "${tool}"${this.stderrHint()}`,
        { cause: error },
      );
    }
    if (
      session?.handle.kind === "http" &&
      error instanceof StreamableHTTPError &&
      error.code === 404
    ) {
      // The server forgot our session (typically a restart): start over with a fresh one.
      this.lostSession(
        session,
        new McpTransportError(this.serverName, `MCP server "${this.serverName}" ended the session`),
      );
      return new McpTransportError(
        this.serverName,
        `MCP server "${this.serverName}" ended the session; reconnecting — try the call again`,
        { cause: error },
      );
    }
    return new McpTransportError(
      this.serverName,
      `Request to MCP server "${this.serverName}" failed: ${maskSecrets(describeError(error))}`,
      { cause: error },
    );
  }

  private connectError(error: unknown): Error {
    if (error instanceof ConnectorError) return error;
    const name = this.serverName;
    const code = errnoCode(error);
    const syscall = errorProperty(error, "syscall");
    if (code === "ENOENT" && syscall?.startsWith("spawn")) {
      const command = errorProperty(error, "path") ?? syscall.slice("spawn ".length);
      return new McpConnectError(
        name,
        `Command not found: "${command}". Install it or use an absolute path (the daemon's PATH ` +
          `may differ from your shell's).`,
        { cause: error },
      );
    }
    if (code === "EACCES" && syscall?.startsWith("spawn")) {
      return new McpConnectError(name, "The configured command is not executable", {
        cause: error,
      });
    }
    const status = httpStatus(error);
    if (status === 401 || status === 403) {
      return new McpConnectError(
        name,
        `Authentication failed (HTTP ${status}). Check the token in "headers"; OAuth sign-in is ` +
          "not supported yet.",
        { cause: error },
      );
    }
    if (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) {
      return new McpConnectError(
        name,
        `MCP server "${name}" closed the connection during startup${this.stderrHint() || " (no stderr output)"}`,
        { cause: error },
      );
    }
    return new McpConnectError(
      name,
      `Could not connect to MCP server "${name}": ${maskSecrets(describeError(error))}${this.stderrHint()}`,
      { cause: error },
    );
  }

  private disposeSession(session: Session): Promise<void> {
    session.closing = true;
    session.disposal ??= (async () => {
      const pid = session.pid ?? session.handle.pid();
      const { transport } = session.handle;
      if (
        !session.dead &&
        transport instanceof StreamableHTTPClientTransport &&
        transport.sessionId !== undefined
      ) {
        await settle(transport.terminateSession(), TERMINATE_SESSION_TIMEOUT_MS);
      }
      // The SDK ends stdin, then escalates to SIGTERM and SIGKILL; the extra kill only covers a
      // close that hangs past all of that.
      const closed = await settle(session.client.close(), CLOSE_TIMEOUT_MS);
      if (!closed && pid !== null) killQuietly(pid);
    })();
    return session.disposal;
  }

  private stderrHint(): string {
    const lines = this.source.stderrTail(3).map(maskSecrets);
    return lines.length > 0 ? ` (stderr: ${truncate(lines.join(" | "), 300)})` : "";
  }

  private closedError(): McpUnavailableError {
    return new McpUnavailableError(
      this.serverName,
      `MCP server "${this.serverName}" was shut down`,
    );
  }

  private unavailableError(): McpUnavailableError {
    const reason = this.failure ? maskSecrets(this.failure.message) : "not connected";
    const waitMs = this.retryAt - this.now();
    const retry = waitMs > 0 ? ` (next attempt in ${Math.ceil(waitMs / 1000)} s)` : "";
    return new McpUnavailableError(
      this.serverName,
      `MCP server "${this.serverName}" is unavailable: ${reason}${retry}`,
      this.retryAt > 0 ? this.retryAt : undefined,
      { cause: this.failure },
    );
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Abortable sleep that never keeps the process alive on its own. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolves `true` if the promise settles within `ms`, `false` otherwise. Never rejects. */
function settle(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    const done = () => {
      clearTimeout(timer);
      resolve(true);
    };
    promise.then(done, done);
  });
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function errorProperty(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value: unknown = Reflect.get(error, key);
  return typeof value === "string" ? value : undefined;
}

/** HTTP status of an SDK transport error anywhere in the cause chain. */
function httpStatus(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ((current instanceof StreamableHTTPError || current instanceof SseError) && current.code) {
      return current.code;
    }
    current = current.cause;
  }
  return undefined;
}

/** `fetch failed` alone is useless; include the network error code underneath it. */
function describeError(error: unknown): string {
  const message = errorMessage(error);
  const causeCode = error instanceof Error ? errnoCode(error.cause) : undefined;
  return causeCode && !message.includes(causeCode) ? `${message} (${causeCode})` : message;
}
