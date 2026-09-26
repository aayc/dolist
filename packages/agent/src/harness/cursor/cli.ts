/**
 * Locating the Cursor CLI, the environment it runs with, and the sign-in check the runtime does
 * before selecting the Cursor harness. `agent status --format json` also prints account details;
 * only the authentication flags are read, nothing else is kept or logged.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "@ddl/core";
import { findExecutable, isExecutable, pathDirs } from "../executables";

export const CURSOR_CLI_NAMES = ["agent", "cursor-agent"] as const;
export const CURSOR_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";
export const CURSOR_LOGIN_COMMAND = "agent login";
const STATUS_TIMEOUT_MS = 15_000;
const MAX_STATUS_OUTPUT = 64 * 1024;

/** Variables the CLI needs (paths, locale, proxies, CA bundles). API keys are never forwarded. */
const PASSED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "SHELL",
  "TZ",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

export type CursorCliStatus =
  | { state: "ready"; binary: string }
  | { state: "missing" }
  | { state: "signed_out"; binary: string }
  | { state: "error"; binary: string; message: string };

export interface CursorCliLookup {
  /** A path, or a command name looked up on PATH. Default: `agent`, then `cursor-agent`. */
  binary?: string;
  env?: NodeJS.ProcessEnv;
  /** Where `~/.local/bin` is looked up (default: the user's home). */
  homeDir?: string;
}

export function findCursorCli(lookup: CursorCliLookup = {}): string | undefined {
  const env = lookup.env ?? process.env;
  const dirs = [
    ...pathDirs(env.PATH),
    path.join(lookup.homeDir ?? env.HOME ?? os.homedir(), ".local", "bin"),
  ];
  if (lookup.binary) {
    if (lookup.binary.includes("/")) {
      return isExecutable(lookup.binary) ? path.resolve(lookup.binary) : undefined;
    }
    return findExecutable(lookup.binary, dirs);
  }
  for (const name of CURSOR_CLI_NAMES) {
    const found = findExecutable(name, dirs);
    if (found) return found;
  }
  return undefined;
}

/** The CLI's environment: the passthrough list from `source`, locale variables, and `extra`. */
export function cliEnvironment(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if ((PASSED_ENV as readonly string[]).includes(key) || key.startsWith("LC_")) env[key] = value;
  }
  env.NO_OPEN_BROWSER = "1";
  return { ...env, ...extra };
}

export interface CursorCliCheckOptions extends CursorCliLookup {
  /** Arguments placed before the CLI's own (tests run a script through `node`). */
  binaryArgs?: readonly string[];
  timeoutMs?: number;
}

/** Runs `agent status --format json` and reports whether the CLI is installed and signed in. */
export async function checkCursorCli(
  options: CursorCliCheckOptions = {},
): Promise<CursorCliStatus> {
  const binary = findCursorCli(options);
  if (!binary) return { state: "missing" };
  const env = cliEnvironment(options.env ?? process.env);
  let output: { code: number | null; stdout: string };
  try {
    output = await run(
      binary,
      [...(options.binaryArgs ?? []), "status", "--format", "json"],
      env,
      options.timeoutMs ?? STATUS_TIMEOUT_MS,
    );
  } catch (error) {
    return {
      state: "error",
      binary,
      message: errorMessage(error),
    };
  }
  const authenticated = parseAuthenticated(output.stdout);
  if (authenticated === undefined) {
    return {
      state: "error",
      binary,
      message: `unexpected output from \`${path.basename(binary)} status\` (exit code ${output.code ?? "none"})`,
    };
  }
  return authenticated ? { state: "ready", binary } : { state: "signed_out", binary };
}

/** `isAuthenticated` from the status JSON; undefined when the output isn't that JSON. */
export function parseAuthenticated(stdout: string): boolean | undefined {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = (parsed as Record<string, unknown>).isAuthenticated;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The runtime's explanation when the Cursor harness can't run; undefined when it can. */
export function cursorCliProblem(status: CursorCliStatus): string | undefined {
  switch (status.state) {
    case "ready":
      return undefined;
    case "missing":
      return `The Cursor CLI is not installed (no \`agent\` or \`cursor-agent\` on PATH or in ~/.local/bin). Install it with \`${CURSOR_INSTALL_COMMAND}\`, sign in with \`${CURSOR_LOGIN_COMMAND}\`, then restart the daemon — or switch the agent harness back to Pi in Settings.`;
    case "signed_out":
      return `The Cursor CLI is not signed in. Run \`${CURSOR_LOGIN_COMMAND}\` in a terminal, then restart the daemon — or switch the agent harness back to Pi in Settings.`;
    case "error":
      return `Couldn't check the Cursor CLI (${status.message}). Make sure \`agent status\` works in a terminal, then restart the daemon.`;
  }
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let stdout = "";
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      reject(
        new Error(
          `\`${path.basename(command)} status\` did not answer within ${Math.round(timeoutMs / 1000)}s`,
        ),
      );
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_STATUS_OUTPUT) stdout += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
}
