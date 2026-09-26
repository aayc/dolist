import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type Logger, silentLogger } from "@ddl/core";
import { ExecutionError } from "../errors";
import type { ShellExecOptions, ShellExecutor, ShellResult } from "../types";
import { HeadTailBuffer } from "./output-buffer";
import { buildChildEnv, unsetPrelude } from "./shell-env";

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
/** SIGTERM → SIGKILL escalation delay when killing a command's process group. */
const KILL_GRACE_MS = 2_000;
/** After the shell exits, how long to wait for background children to release its pipes. */
const DRAIN_MS = 250;

/** setTimeout fires immediately for delays above 2^31-1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_SHELL_TIMEOUT_MS;
  }
  return Math.min(timeoutMs, MAX_TIMER_MS);
}

const POSIX_SHELLS = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

/**
 * The user's shell when it is POSIX-compatible (model-written commands are bash-flavoured, so
 * fish/nu are skipped), else bash, else sh.
 */
export function resolveShell(
  preferred: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string {
  if (preferred && isAbsolute(preferred) && POSIX_SHELLS.has(basename(preferred))) {
    if (exists(preferred)) return preferred;
  }
  return exists("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

export interface LocalShellOptions {
  /** Absolute path of a POSIX shell. Default: {@link resolveShell} of `$SHELL`. */
  shell?: string;
  /** Run as a login shell (`-l`) so PATH matches the user's terminal (Homebrew etc.). Default true. */
  login?: boolean;
  /** Base environment for commands (sanitized). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/**
 * Runs commands through the user's shell on this machine. Each command gets its own process group
 * so a timeout/abort kills everything it started; sensitive daemon variables never reach it.
 */
export class LocalShellExecutor implements ShellExecutor {
  readonly shell: string;
  private readonly login: boolean;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly logger: Logger;
  private readonly running = new Set<ChildProcess>();

  constructor(options: LocalShellOptions = {}) {
    this.shell = options.shell ?? resolveShell(process.env.SHELL);
    this.login = options.login ?? true;
    this.baseEnv = options.env ?? process.env;
    this.logger = options.logger ?? silentLogger;
  }

  async exec(command: string, options: ShellExecOptions): Promise<ShellResult> {
    const { signal } = options;
    if (signal?.aborted) throw signal.reason;
    const cwdStat = await stat(options.cwd).catch(() => undefined);
    if (!cwdStat?.isDirectory()) {
      throw new ExecutionError(`Working directory does not exist: ${options.cwd}`);
    }
    const { env, stripped } = buildChildEnv(this.baseEnv, options.env);
    const args = [...(this.login ? ["-l"] : []), "-c", unsetPrelude(stripped) + command];
    const timeoutMs = clampTimeout(options.timeoutMs);
    const output = new HeadTailBuffer(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    const startedAt = performance.now();

    return new Promise<ShellResult>((resolve, reject) => {
      const child = spawn(this.shell, args, {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      this.running.add(child);

      let timedOut = false;
      let aborted = false;
      let exitCode: number | null = null;
      let settled = false;
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const later = (ms: number, fn: () => void) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          fn();
        }, ms);
        timers.add(timer);
      };

      const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")] as const;
      const onText = (text: string) => {
        if (!text) return;
        output.push(text);
        try {
          options.onData?.(text);
        } catch (error) {
          this.logger.warn("shell onData listener failed", { error: String(error) });
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => onText(decoders[0].write(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => onText(decoders[1].write(chunk)));

      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          // ESRCH: the group is already gone.
        }
      };
      const terminate = () => {
        killGroup("SIGTERM");
        later(KILL_GRACE_MS, () => killGroup("SIGKILL"));
        // Last resort if the process never reports exit (e.g. stuck in uninterruptible I/O).
        later(KILL_GRACE_MS + 1_000, finish);
      };
      const onAbort = () => {
        aborted = true;
        terminate();
      };

      const cleanup = () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        signal?.removeEventListener("abort", onAbort);
        this.running.delete(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        onText(decoders[0].end());
        onText(decoders[1].end());
        cleanup();
        if (aborted && signal) {
          reject(signal.reason);
          return;
        }
        resolve({
          exitCode,
          output: output.toString(),
          timedOut,
          truncated: output.truncated,
          durationMs: Math.round(performance.now() - startedAt),
        });
      };

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new ExecutionError(`Failed to start ${this.shell}: ${error.message}`, { cause: error }),
        );
      });
      child.once("exit", (code) => {
        exitCode = code;
        later(DRAIN_MS, finish);
      });
      child.once("close", finish);

      later(timeoutMs, () => {
        timedOut = true;
        terminate();
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    }).then((result) => {
      this.logger.debug("shell command finished", {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        commandChars: command.length,
      });
      return result;
    });
  }

  /** Kills every running command's process group (daemon shutdown). */
  async dispose(): Promise<void> {
    for (const child of this.running) {
      if (child.pid === undefined) continue;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    this.running.clear();
  }
}
