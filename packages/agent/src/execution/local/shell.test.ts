import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionError } from "../errors";
import { HeadTailBuffer, utf8Head, utf8Tail } from "./output-buffer";
import { LocalShellExecutor, resolveShell } from "./shell";
import { buildChildEnv, isSensitiveEnvName, unsetPrelude } from "./shell-env";

const SAFE_BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir() };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !isAlive(pid);
}

describe("LocalShellExecutor", () => {
  let dir: string;
  let shell: LocalShellExecutor;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "ddl-shell-")));
    shell = new LocalShellExecutor({ shell: "/bin/sh", login: false, env: SAFE_BASE_ENV });
  });

  afterEach(async () => {
    await shell.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it("reports exit codes and output", async () => {
    const ok = await shell.exec("echo hello", { cwd: dir });
    expect(ok).toMatchObject({ exitCode: 0, output: "hello\n", timedOut: false, truncated: false });
    expect(ok.durationMs).toBeGreaterThanOrEqual(0);

    const failed = await shell.exec("echo oops >&2; exit 3", { cwd: dir });
    expect(failed.exitCode).toBe(3);
    expect(failed.output).toBe("oops\n");
  });

  it("runs in the requested working directory", async () => {
    const result = await shell.exec("pwd", { cwd: dir });
    expect(result.output.trim()).toBe(dir);
  });

  it("rejects a missing working directory", async () => {
    await expect(shell.exec("true", { cwd: join(dir, "missing") })).rejects.toBeInstanceOf(
      ExecutionError,
    );
  });

  it("returns combined stdout/stderr in arrival order and streams chunks", async () => {
    const chunks: string[] = [];
    const result = await shell.exec(
      "echo out1; sleep 0.1; echo err1 >&2; sleep 0.1; echo out2; sleep 0.1; echo err2 >&2",
      { cwd: dir, onData: (chunk) => chunks.push(chunk) },
    );
    expect(result.output).toBe("out1\nerr1\nout2\nerr2\n");
    expect(chunks.join("")).toBe(result.output);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps multi-byte characters intact", async () => {
    const result = await shell.exec("printf 'héllo wörld 😀\\n'", { cwd: dir });
    expect(result.output).toBe("héllo wörld 😀\n");
  });

  it("kills the whole process group on timeout", async () => {
    const pidFile = join(dir, "bg.pid");
    const started = Date.now();
    // Long enough for the shell to start the background job even on a busy machine.
    const result = await shell.exec(`sleep 30 & echo $! > ${pidFile}; sleep 30`, {
      cwd: dir,
      timeoutMs: 1500,
    });
    expect(result.timedOut).toBe(true);
    // A shell waiting on a foreground job may report the SIGTERM as its exit status (128 + 15).
    expect([null, 143]).toContain(result.exitCode);
    expect(Date.now() - started).toBeLessThan(5000);
    const backgroundPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(backgroundPid).toBeGreaterThan(0);
    expect(await waitUntilDead(backgroundPid)).toBe(true);
  });

  it("aborts via AbortSignal and kills the process group", async () => {
    const pidFile = join(dir, "bg.pid");
    const controller = new AbortController();
    const pending = shell.exec(`sleep 30 & echo $! > ${pidFile}; sleep 30`, {
      cwd: dir,
      signal: controller.signal,
    });
    await vi.waitFor(
      async () => expect((await readFile(pidFile, "utf8").catch(() => "")).trim()).not.toBe(""),
      { timeout: 5000, interval: 20 },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const backgroundPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(await waitUntilDead(backgroundPid)).toBe(true);
  });

  it("does not spawn when the signal is already aborted", async () => {
    const marker = join(dir, "ran");
    const controller = new AbortController();
    controller.abort();
    await expect(
      shell.exec(`touch ${marker}`, { cwd: dir, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("truncates long output keeping head and tail", async () => {
    const result = await shell.exec(
      "printf 'HEAD'; head -c 50000 /dev/zero | tr '\\0' x; printf 'TAIL'",
      { cwd: dir, maxOutputBytes: 200 },
    );
    expect(result.truncated).toBe(true);
    expect(result.output.startsWith("HEAD")).toBe(true);
    expect(result.output.endsWith("TAIL")).toBe(true);
    expect(result.output).toMatch(/\[\.\.\. \d+ bytes of output omitted \.\.\.\]/);
    expect(result.output.length).toBeLessThan(400);
  });

  it("strips sensitive variables, including ones the login profile could re-export", async () => {
    const executor = new LocalShellExecutor({
      shell: "/bin/sh",
      login: false,
      env: {
        ...SAFE_BASE_ENV,
        OPENROUTER_API_KEY: "test-openrouter",
        DDL_AUTH_TOKEN: "test-token",
        ACME_API_KEY: "test-acme",
        SAFE_VAR: "visible",
      },
    });
    const result = await executor.exec("env", {
      cwd: dir,
      env: { EXTRA_VAR: "extra", ANTHROPIC_API_KEY: "test-anthropic" },
    });
    expect(result.output).toContain("SAFE_VAR=visible");
    expect(result.output).toContain("EXTRA_VAR=extra");
    expect(result.output).toContain("TERM=dumb");
    for (const name of [
      "OPENROUTER_API_KEY",
      "DDL_AUTH_TOKEN",
      "ACME_API_KEY",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(result.output).not.toContain(`${name}=`);
    }
    expect(result.output).not.toContain("test-");
  });

  it("uses a login shell by default", async () => {
    const bash = new LocalShellExecutor({ shell: "/bin/bash", env: SAFE_BASE_ENV });
    const result = await bash.exec("shopt -q login_shell && echo LOGIN_SHELL", { cwd: dir });
    expect(result.output).toContain("LOGIN_SHELL");
  });

  it("kills running commands on dispose", async () => {
    const pending = shell.exec("sleep 30", { cwd: dir, timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 200));
    await shell.dispose();
    const result = await pending;
    expect(result.exitCode).toBeNull();
  });
});

describe("resolveShell", () => {
  it("prefers the user's POSIX shell", () => {
    expect(resolveShell("/bin/zsh", () => true)).toBe("/bin/zsh");
  });

  it("skips non-POSIX or relative shells", () => {
    const exists = (path: string) => path === "/bin/bash";
    expect(resolveShell("/opt/homebrew/bin/fish", exists)).toBe("/bin/bash");
    expect(resolveShell("zsh", exists)).toBe("/bin/bash");
    expect(resolveShell(undefined, () => false)).toBe("/bin/sh");
  });
});

describe("shell env", () => {
  it("classifies sensitive names", () => {
    for (const name of ["OPENROUTER_API_KEY", "openai_api_key", "DDL_TOKEN", "DDL_AUTH_TOKEN"]) {
      expect(isSensitiveEnvName(name)).toBe(true);
    }
    for (const name of ["DDL_HOME", "DDL_PORT", "PATH", "GITHUB_TOKEN", "API_KEY_PATH"]) {
      expect(isSensitiveEnvName(name)).toBe(false);
    }
  });

  it("merges overrides, applies non-interactive defaults and reports stripped names", () => {
    const { env, stripped } = buildChildEnv(
      { PATH: "/bin", TERM: "xterm-256color", OPENAI_API_KEY: "x", UNSET: undefined },
      { TERM: "vt100", DDL_SESSION_TOKEN: "y" },
    );
    expect(env).toMatchObject({ PATH: "/bin", TERM: "vt100", NO_COLOR: "1", PAGER: "cat" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("UNSET");
    expect(stripped).toEqual(["DDL_SESSION_TOKEN", "OPENAI_API_KEY"]);
  });

  it("only inlines valid identifiers in the unset prelude", () => {
    expect(unsetPrelude([])).toBe("");
    expect(unsetPrelude(["A_API_KEY", "bad;name", "B"])).toBe("unset A_API_KEY B 2>/dev/null\n");
  });
});

describe("HeadTailBuffer", () => {
  it("returns everything when under the limit", () => {
    const buffer = new HeadTailBuffer(100);
    buffer.push("hello ");
    buffer.push("world");
    expect(buffer.truncated).toBe(false);
    expect(buffer.toString()).toBe("hello world");
  });

  it("keeps head and tail across many chunks", () => {
    const buffer = new HeadTailBuffer(20);
    buffer.push("0123456789");
    for (let i = 0; i < 100; i++) buffer.push("..........");
    buffer.push("abcdefghij");
    expect(buffer.truncated).toBe(true);
    const text = buffer.toString();
    expect(text.startsWith("0123456789")).toBe(true);
    expect(text.endsWith("abcdefghij")).toBe(true);
    expect(text).toContain("1000 bytes of output omitted");
  });

  it("never splits multi-byte characters", () => {
    const buffer = new HeadTailBuffer(11);
    buffer.push("😀".repeat(50));
    const text = buffer.toString();
    expect(text).not.toContain("\uFFFD");
    expect(text.startsWith("😀")).toBe(true);
    expect(text.endsWith("😀")).toBe(true);
  });

  it("cuts UTF-8 on character boundaries", () => {
    expect(utf8Head("aé😀", 4)).toBe("aé");
    expect(utf8Tail("aé😀", 5)).toBe("😀");
    expect(utf8Tail("aé😀", 3)).toBe("");
  });
});
