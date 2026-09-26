import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { errorMessage, type Logger, silentLogger } from "@ddl/core";
import { ComputerUnavailableError, ExecutionError } from "../../errors";
import { abortReason } from "../../util/abort";
import {
  HELPER_PROTOCOL_VERSION,
  HelperError,
  type HelperMethod,
  parseHello,
  parseResponse,
} from "./protocol";

export const DEFAULT_HELPER_TIMEOUT_MS = 10_000;
const HELLO_TIMEOUT_MS = 10_000;
const FIRST_RESTART_DELAY_MS = 250;
const MAX_RESTART_DELAY_MS = 30_000;
/** A call arriving during a longer restart delay fails fast instead of waiting. */
const MAX_WAIT_FOR_RESTART_MS = 2_000;
/** A helper that stayed up this long resets the backoff. */
const STABLE_UPTIME_MS = 30_000;
/** A response line longer than this (a runaway helper) kills the process. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;
const STOP_GRACE_MS = 1_500;
/** Variables the helper may see; everything else (API keys, tokens) stays in the daemon. */
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"];

export type SpawnHelper = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface HelperClientOptions {
  /** The `ddl-computer` executable (tests: `node` with the fake helper script in `args`). */
  command: string;
  /** Default `["serve"]`. */
  args?: readonly string[];
  /** Base environment, reduced to an allowlist. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  firstRestartDelayMs?: number;
  maxRestartDelayMs?: number;
  /** How long a started helper may take to answer `hello`. Default 10 s. */
  helloTimeoutMs?: number;
  spawn?: SpawnHelper;
  now?: () => number;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  method: HelperMethod;
  running: Running;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Running {
  child: ChildProcess;
  startedAt: number;
  exited: boolean;
}

const defaultSpawn: SpawnHelper = (command, args, options) =>
  nodeSpawn(command, [...args], { env: options.env, stdio: ["pipe", "pipe", "pipe"] });

function helperEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) if (base[key] !== undefined) env[key] = base[key];
  return env;
}

/**
 * JSON-lines RPC with the `ddl-computer serve` helper: started on first use (after a `hello`
 * version check), requests pipelined and matched by id, each with its own timeout. When the helper
 * dies, pending calls fail and the next call restarts it after an exponential backoff; a helper
 * that is missing or speaks another protocol version disables the client for good.
 */
export class HelperClient {
  private readonly options: HelperClientOptions;
  private readonly logger: Logger;
  private readonly spawnHelper: SpawnHelper;
  private readonly now: () => number;
  private readonly pending = new Map<number, Pending>();
  private running: Running | undefined;
  private starting: Promise<Running> | undefined;
  private nextId = 1;
  private failures = 0;
  private restartAt = 0;
  private fatal: ExecutionError | undefined;
  private disposed = false;

  constructor(options: HelperClientOptions) {
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child({ component: "computer-helper" });
    this.spawnHelper = options.spawn ?? defaultSpawn;
    this.now = options.now ?? Date.now;
  }

  /** False once the helper can't be used at all (missing, incompatible, or disposed). */
  get available(): boolean {
    return !this.disposed && this.fatal === undefined;
  }

  /** The helper's process id while it runs. */
  get pid(): number | undefined {
    return this.running && !this.running.exited ? this.running.child.pid : undefined;
  }

  async call(method: HelperMethod, params: object, options: CallOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const running = await this.ensureRunning();
    return this.send(running, method, params, options);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new ComputerUnavailableError("The computer helper was shut down."));
    const running = this.running;
    this.running = undefined;
    if (running && !running.exited) await stop(running);
  }

  private ensureRunning(): Promise<Running> {
    if (this.disposed) {
      return Promise.reject(new ComputerUnavailableError("The computer helper was shut down."));
    }
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.running && !this.running.exited) return Promise.resolve(this.running);
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<Running> {
    const wait = this.restartAt - this.now();
    if (wait > MAX_WAIT_FOR_RESTART_MS) {
      throw new ExecutionError(
        `The computer helper stopped unexpectedly; it restarts in ${Math.ceil(wait / 1000)} s. Try again then.`,
      );
    }
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (this.disposed) throw new ComputerUnavailableError("The computer helper was shut down.");

    const child = this.spawnHelper(this.options.command, this.options.args ?? ["serve"], {
      env: helperEnv(this.options.env ?? process.env),
    });
    const running: Running = { child, startedAt: this.now(), exited: false };
    try {
      await spawned(child);
    } catch (error) {
      running.exited = true;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC") {
        this.fatal = new ComputerUnavailableError(
          `The computer helper can't be started (${code}): app control is unavailable.`,
        );
        this.logger.warn("computer helper unavailable", { code });
        throw this.fatal;
      }
      this.noteFailure();
      throw new ExecutionError(`The computer helper failed to start: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    this.attach(running);
    this.running = running;
    let hello: { version: number; pid: number };
    try {
      const timeoutMs = this.options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
      hello = parseHello(await this.send(running, "hello", {}, { timeoutMs }));
    } catch (error) {
      await stop(running);
      throw error;
    }
    if (hello.version !== HELPER_PROTOCOL_VERSION) {
      this.fatal = new ComputerUnavailableError(
        `The computer helper speaks protocol ${hello.version}, this daemon ${HELPER_PROTOCOL_VERSION}: app control is unavailable until both are updated.`,
      );
      this.logger.warn("incompatible computer helper", { version: hello.version });
      await stop(running);
      throw this.fatal;
    }
    this.logger.debug("computer helper started", { pid: hello.pid });
    return running;
  }

  private attach(running: Running): void {
    const { child } = running;
    const decoder = new StringDecoder("utf8");
    let partial = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      let start = 0;
      let newline = text.indexOf("\n");
      while (newline !== -1) {
        this.onLine(partial + text.slice(start, newline));
        partial = "";
        start = newline + 1;
        newline = text.indexOf("\n", start);
      }
      partial += text.slice(start);
      if (partial.length > MAX_LINE_CHARS) {
        partial = "";
        this.logger.warn("computer helper sent an oversized response; restarting it");
        child.kill("SIGKILL");
      }
    });
    const stderr = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of stderr.write(chunk).split("\n")) {
        if (line.trim()) this.logger.debug("computer helper", { line: line.slice(0, 300) });
      }
    });
    child.stdin?.on("error", (error) => {
      this.logger.debug("computer helper stdin error", { error: errorMessage(error) });
    });
    child.on("error", (error) => {
      this.logger.debug("computer helper process error", { error: errorMessage(error) });
    });
    child.once("exit", () => {
      running.exited = true;
      if (this.running === running) this.running = undefined;
    });
    // After `close`, every response the helper wrote before exiting has been delivered.
    child.once("close", (code, signal) => this.onExit(running, code, signal));
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    const response = parseResponse(line);
    if (!response) {
      this.logger.debug("ignoring a line from the computer helper", { line: line.slice(0, 120) });
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if ("error" in response) {
      pending.reject(new HelperError(response.error.code, response.error.message, pending.method));
    } else {
      pending.resolve(response.result);
    }
  }

  private onExit(running: Running, code: number | null, signal: NodeJS.Signals | null): void {
    running.exited = true;
    if (this.running === running) this.running = undefined;
    this.rejectAll(
      new ExecutionError(
        `The computer helper stopped unexpectedly (${signal ?? `exit code ${code}`}). Try again.`,
      ),
      running,
    );
    if (this.disposed || this.fatal) return;
    if (this.now() - running.startedAt >= STABLE_UPTIME_MS) this.failures = 0;
    this.noteFailure();
    this.logger.warn("computer helper stopped", { code, signal, restartInMs: this.restartDelay() });
  }

  private noteFailure(): void {
    this.failures++;
    this.restartAt = this.now() + this.restartDelay();
  }

  private restartDelay(): number {
    const first = this.options.firstRestartDelayMs ?? FIRST_RESTART_DELAY_MS;
    const max = this.options.maxRestartDelayMs ?? MAX_RESTART_DELAY_MS;
    return this.failures === 0 ? 0 : Math.min(max, first * 2 ** (this.failures - 1));
  }

  private send(
    running: Running,
    method: HelperMethod,
    params: object,
    options: CallOptions,
  ): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle(() => reject(abortReason(signal!)));
      const settle = (done: () => void) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        done();
      };
      this.pending.set(id, {
        method,
        running,
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error)),
      });
      timer = setTimeout(() => {
        settle(() =>
          reject(
            new ExecutionError(
              `The computer helper didn't answer ${method} within ${Math.round(timeoutMs / 1000)} s.`,
            ),
          ),
        );
        // A helper that stops answering is wedged; the next call starts a fresh one.
        if (!running.exited) running.child.kill("SIGKILL");
      }, timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      const line = `${JSON.stringify({ id, method, params })}\n`;
      if (!running.child.stdin?.writable) {
        settle(() => reject(new ExecutionError("The computer helper isn't accepting requests.")));
        return;
      }
      running.child.stdin.write(line, (error) => {
        if (error) {
          settle(() =>
            reject(new ExecutionError(`Couldn't reach the computer helper: ${error.message}`)),
          );
        }
      });
    });
  }

  /** Fails the calls sent to `running` (every call without it). */
  private rejectAll(error: Error, running?: Running): void {
    for (const pending of [...this.pending.values()]) {
      if (!running || pending.running === running) pending.reject(error);
    }
  }
}

function spawned(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

async function stop(running: Running): Promise<void> {
  const { child } = running;
  if (running.exited) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const within = (ms: number) =>
    Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(r, ms, false))]);
  child.stdin?.end();
  if (await within(STOP_GRACE_MS)) return;
  child.kill("SIGTERM");
  if (await within(STOP_GRACE_MS)) return;
  child.kill("SIGKILL");
  await within(STOP_GRACE_MS);
}
