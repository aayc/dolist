/**
 * JSON-RPC 2.0 over newline-delimited JSON on a child process's stdio: the transport of the Agent
 * Client Protocol. Requests we send, notifications, and requests the agent sends us (answered by
 * `onRequest`). The child runs in its own process group so closing it also stops the helper
 * processes the Cursor CLI starts (its worker server, language servers).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { type Logger, silentLogger } from "@ddl/core";

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

export class AcpClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpClosedError";
  }
}

export class AcpTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`The Cursor CLI did not answer ${method} within ${Math.round(ms / 1000)}s`);
    this.name = "AcpTimeoutError";
  }
}

export const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const STDERR_TAIL_BYTES = 8 * 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export interface AcpExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be started (e.g. ENOENT). */
  error?: string;
}

export interface AcpHandlers {
  onNotification?: (method: string, params: unknown) => void;
  /** Answers requests from the agent; throw `AcpRpcError` for protocol errors. */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
  onExit?: (exit: AcpExit) => void;
}

export interface AcpConnectionOptions extends AcpHandlers {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  logger?: Logger;
  maxLineBytes?: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class AcpConnection {
  private readonly child: ChildProcess;
  private readonly options: AcpConnectionOptions;
  private handlers: AcpHandlers;
  private readonly logger: Logger;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exited: Promise<void>;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closedWith: AcpClosedError | undefined;

  private constructor(options: AcpConnectionOptions) {
    this.options = options;
    this.handlers = options;
    this.logger = options.logger ?? silentLogger;
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.finish({ code, signal });
        resolve();
      });
      this.child.once("error", (error) => {
        this.finish({ code: null, signal: null, error: error.message });
        resolve();
      });
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_TAIL_BYTES);
    });
    this.child.stdin?.on("error", (error) => {
      this.logger.debug("ACP stdin error", { error: error.message });
    });
  }

  static spawn(options: AcpConnectionOptions): AcpConnection {
    return new AcpConnection(options);
  }

  get closed(): boolean {
    return this.closedWith !== undefined;
  }

  /** Hands the connection to a new owner (a prewarmed CLI to its session). */
  bind(handlers: AcpHandlers): void {
    this.handlers = handlers;
  }

  /** The CLI's process id, which is also its process group's (it's spawned detached). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** The last lines the CLI wrote to stderr (for error messages; never logged at info). */
  stderrTail(maxChars = 500): string {
    const lines = this.stderr.trim().split("\n").filter(Boolean);
    return lines.slice(-3).join(" | ").slice(-maxChars);
  }

  request(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = { method, resolve, reject };
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpTimeoutError(method, options.timeoutMs ?? 0));
        }, options.timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closedWith) this.write({ jsonrpc: "2.0", method, params });
  }

  /** Ends the process group: stdin EOF and SIGTERM, then SIGKILL after `graceMs`. */
  async close(graceMs = 2_000): Promise<void> {
    if (this.closedWith) return;
    this.child.stdin?.end();
    this.signalGroup("SIGTERM");
    const timer = setTimeout(() => this.signalGroup("SIGKILL"), graceMs);
    await this.exited;
    clearTimeout(timer);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  }

  private write(message: unknown): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.logger.debug("ACP write failed", { error: messageOf(error) });
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > (this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)) {
      this.logger.warn("ACP message too large; closing the connection");
      this.buffer = "";
      void this.close(0);
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.debug("ignoring non-JSON output from the Cursor CLI", { length: line.length });
      return;
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0") return;
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined || id === null) this.dispatchNotification(method, message.params);
      else if (typeof id === "number" || typeof id === "string") {
        void this.dispatchRequest(id, method, message.params);
      }
      return;
    }
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (isRecord(message.error)) {
      const { code, message: text, data } = message.error;
      entry.reject(
        new AcpRpcError(
          typeof code === "number" ? code : INTERNAL_ERROR,
          typeof text === "string" && text ? text : `${entry.method} failed`,
          data,
        ),
      );
    } else {
      entry.resolve(message.result);
    }
  }

  private dispatchNotification(method: string, params: unknown): void {
    try {
      this.handlers.onNotification?.(method, params);
    } catch (error) {
      this.logger.warn("ACP notification handler threw", { method, error: messageOf(error) });
    }
  }

  private async dispatchRequest(id: number | string, method: string, params: unknown) {
    try {
      const { onRequest } = this.handlers;
      if (!onRequest) throw new AcpRpcError(METHOD_NOT_FOUND, "Method not found");
      const result = await onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const code = error instanceof AcpRpcError ? error.code : INTERNAL_ERROR;
      this.write({ jsonrpc: "2.0", id, error: { code, message: messageOf(error) } });
    }
  }

  private finish(exit: AcpExit): void {
    if (this.closedWith) return;
    // Helpers the CLI started outlive it in its group. Only now is the group id surely still
    // ours: signalling it later could reach an unrelated group that reused the id.
    this.signalGroup("SIGTERM");
    const tail = this.stderrTail();
    const how = exit.error
      ? `could not start (${exit.error})`
      : `exited (${exit.signal ?? `code ${exit.code}`})`;
    this.closedWith = new AcpClosedError(`The Cursor CLI ${how}${tail ? `: ${tail}` : ""}`);
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(this.closedWith);
    }
    this.pending.clear();
    try {
      this.handlers.onExit?.(exit);
    } catch (error) {
      this.logger.warn("ACP exit handler threw", { error: messageOf(error) });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
