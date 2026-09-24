import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClosedError, AcpConnection, AcpRpcError, AcpTimeoutError } from "./acp";
import {
  checkCursorCli,
  cliEnvironment,
  cursorCliProblem,
  findCursorCli,
  parseAuthenticated,
} from "./cli";
import {
  type CursorHome,
  cliPermissions,
  createSessionDirs,
  cursorHome,
  prepareCursorHome,
  readUserMcpServers,
  recordCliProcess,
  removeSessionDirs,
  type SessionDirs,
  stopLeftoverClis,
  writeCliConfig,
} from "./workspace";

const FAKE_CLI = fileURLToPath(new URL("./testing/fake-cursor-cli.ts", import.meta.url));
/** These tests start the fake CLI as a process; a loaded machine can take seconds to do that. */
const SPAWN_TIMEOUT_MS = 30_000;
const dirs: string[] = [];
const processes: ChildProcess[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.pid !== undefined && isAlive(child.pid)) process.kill(-child.pid, "SIGKILL");
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A detached process that runs until killed, working in `cwd` (like a CLI left by a dead daemon). */
function lingering(cwd: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  processes.push(child);
  return child;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ddl-cursor-ws-"));
  dirs.push(dir);
  return dir;
}

const mode = async (file: string) => (await stat(file)).mode & 0o777;

describe("Cursor harness files", () => {
  it("denies every built-in and the user's MCP servers, and allows only ours", () => {
    expect(cliPermissions("ddl", ["notes", "ddl", "mail"])).toEqual({
      allow: ["Mcp(ddl:*)"],
      deny: [
        "Read(**)",
        "Read(/**)",
        "Write(**)",
        "Write(/**)",
        "Shell(*)",
        "WebFetch(*)",
        "Mcp(notes:*)",
        "Mcp(mail:*)",
      ],
    });
  });

  it("reads the user's MCP server names, tolerating empty or broken files", async () => {
    const home = await tempDir();
    expect(await readUserMcpServers(home)).toEqual([]);
    await mkdir(path.join(home, ".cursor"));
    await writeFile(path.join(home, ".cursor", "mcp.json"), "");
    expect(await readUserMcpServers(home)).toEqual([]);
    await writeFile(path.join(home, ".cursor", "mcp.json"), "{ not json");
    expect(await readUserMcpServers(home)).toEqual([]);
    await writeFile(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { calendar: {}, "team-docs": {}, "bad name": {}, "x:y": {} } }),
    );
    expect(await readUserMcpServers(home)).toEqual(["calendar", "team-docs"]);
  });

  it("creates private session directories with AGENTS.md and the project config", async () => {
    const home = cursorHome(await tempDir());
    const permissions = cliPermissions("ddl", []);
    await prepareCursorHome(home, permissions);
    const session = await createSessionDirs(home, "thr_ABC/../x", {
      agentsMd: "# Prompt\n",
      permissions,
    });
    expect(path.dirname(session.root)).toBe(home.sessionsDir);
    expect(path.basename(session.root)).toMatch(/^thr-abc-x-[0-9a-f]{8}$/);
    for (const dir of [
      home.root,
      home.configDir,
      home.sessionsDir,
      session.root,
      session.workspace,
      session.data,
    ]) {
      expect(await mode(dir)).toBe(0o700);
    }
    expect((await readdir(session.workspace)).sort()).toEqual([".cursor", "AGENTS.md"]);
    expect(await readFile(path.join(session.workspace, "AGENTS.md"), "utf8")).toBe("# Prompt\n");
    expect(await mode(path.join(session.workspace, "AGENTS.md"))).toBe(0o600);
    expect(
      JSON.parse(await readFile(path.join(session.workspace, ".cursor", "cli.json"), "utf8")),
    ).toEqual({
      permissions,
    });
    await removeSessionDirs(session);
    expect(await readdir(home.sessionsDir)).toEqual([]);
  });

  it("merges its settings into the CLI config, keeping the CLI's own state", async () => {
    const configDir = await tempDir();
    const file = path.join(configDir, "cli-config.json");
    await writeFile(
      file,
      JSON.stringify({
        approvalMode: "unrestricted",
        autoAcceptWebSearch: true,
        permissions: { allow: ["Shell(*)"], deny: [] },
        privacyCache: { privacyMode: 1 },
      }),
    );
    await writeCliConfig(configDir, cliPermissions("ddl", []));
    const config = JSON.parse(await readFile(file, "utf8"));
    expect(config).toMatchObject({
      approvalMode: "allowlist",
      autoAcceptWebSearch: false,
      sandbox: { mode: "enabled" },
      permissions: { allow: ["Mcp(ddl:*)"] },
      privacyCache: { privacyMode: 1 },
    });
    expect(config.permissions.deny).toContain("Shell(*)");
    expect(await mode(file)).toBe(0o600);
  });

  it("removes stale sessions and transcripts but not live ones", async () => {
    const home = cursorHome(await tempDir());
    const permissions = cliPermissions("ddl", []);
    await prepareCursorHome(home, permissions);
    const live = await createSessionDirs(home, "live", { agentsMd: "", permissions });
    await mkdir(path.join(home.sessionsDir, "dead-1"));
    await mkdir(path.join(home.configDir, "acp-sessions", "old"), { recursive: true });
    await prepareCursorHome(home, permissions);
    expect(await readdir(home.sessionsDir)).toEqual([path.basename(live.root)]);
    expect(await readdir(path.join(home.configDir, "acp-sessions"))).toEqual([]);
    await removeSessionDirs(live);
  });
});

describe("CLI processes left by a daemon that died", { timeout: SPAWN_TIMEOUT_MS }, () => {
  const permissions = cliPermissions("ddl", []);

  /** A session folder another (now dead) daemon process created: no live session owns it. */
  async function leftoverSession(home: CursorHome, name: string): Promise<SessionDirs> {
    const root = path.join(home.sessionsDir, name);
    const session = {
      root,
      workspace: path.join(root, "workspace"),
      data: path.join(root, "data"),
    };
    await mkdir(session.workspace, { recursive: true });
    await mkdir(session.data, { recursive: true });
    return session;
  }

  it("are stopped when the next harness prepares, and their session folders removed", async () => {
    const home = cursorHome(await tempDir());
    await prepareCursorHome(home, permissions);
    const session = await leftoverSession(home, "orchestrator-2026-09-24-0a1b2c3d");
    const cli = lingering(session.workspace);
    await recordCliProcess(session, cli.pid);

    await prepareCursorHome(home, permissions);
    await expect.poll(() => isAlive(cli.pid!), { timeout: 5_000 }).toBe(false);
    expect(await readdir(home.sessionsDir)).toEqual([]);
  });

  it("leave a recorded pid alone when that process works elsewhere (a reused pid)", async () => {
    const home = cursorHome(await tempDir());
    await prepareCursorHome(home, permissions);
    const session = await leftoverSession(home, "thr-x-0a1b2c3d");
    const unrelated = lingering(await tempDir());
    await recordCliProcess(session, unrelated.pid);

    expect(await stopLeftoverClis(home)).toBe(0);
    expect(isAlive(unrelated.pid!)).toBe(true);
  });

  it("of live sessions are left running", async () => {
    const home = cursorHome(await tempDir());
    await prepareCursorHome(home, permissions);
    const session = await createSessionDirs(home, "thr_live", { agentsMd: "# x", permissions });
    const cli = lingering(session.workspace);
    await recordCliProcess(session, cli.pid);

    expect(await stopLeftoverClis(home)).toBe(0);
    expect(isAlive(cli.pid!)).toBe(true);
    await removeSessionDirs(session);
  });
});

describe("Cursor CLI discovery and status", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("finds the CLI by path, by name on PATH, or in ~/.local/bin", async () => {
    const home = await tempDir();
    const bin = path.join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "cursor-agent"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findCursorCli({ env: { PATH: "" }, homeDir: home })).toBe(
      path.join(bin, "cursor-agent"),
    );
    await writeFile(path.join(bin, "agent"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findCursorCli({ env: { PATH: "" }, homeDir: home })).toBe(path.join(bin, "agent"));
    expect(findCursorCli({ binary: path.join(bin, "agent"), env: {}, homeDir: home })).toBe(
      path.join(bin, "agent"),
    );
    expect(findCursorCli({ binary: "/nope/agent", env: {}, homeDir: home })).toBeUndefined();
    expect(findCursorCli({ env: { PATH: "" }, homeDir: await tempDir() })).toBeUndefined();
  });

  it("forwards only what the CLI needs, never API keys", () => {
    const env = cliEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        HTTPS_PROXY: "http://proxy.example.com:8080",
        OPENROUTER_API_KEY: "sk-or-secret",
        CURSOR_API_KEY: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        DDL_TOKEN: "secret",
      },
      { CURSOR_CONFIG_DIR: "/c" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      HTTPS_PROXY: "http://proxy.example.com:8080",
      NO_OPEN_BROWSER: "1",
      CURSOR_CONFIG_DIR: "/c",
    });
  });

  it("reports ready, signed out, garbage output, timeouts and a missing CLI", async () => {
    const check = (flags: string[], timeoutMs?: number) =>
      checkCursorCli({
        binary: process.execPath,
        binaryArgs: [FAKE_CLI, ...flags],
        env: { PATH: process.env.PATH },
        ...(timeoutMs ? { timeoutMs } : {}),
      });
    const [ready, signedOut, garbage, hang, missing] = await Promise.all([
      check([]),
      check(["--fake-auth=signed_out"]),
      check(["--fake-auth=garbage"]),
      check(["--fake-auth=hang"], 300),
      checkCursorCli({ binary: "/nope/agent" }),
    ]);
    expect(ready).toEqual({ state: "ready", binary: process.execPath });
    expect(signedOut).toEqual({ state: "signed_out", binary: process.execPath });
    expect(garbage).toMatchObject({ state: "error", message: /unexpected output/ });
    expect(hang).toMatchObject({ state: "error", message: /did not answer/ });
    expect(missing).toEqual({ state: "missing" });
    expect(parseAuthenticated('{"isAuthenticated":true,"userInfo":{}}')).toBe(true);
    expect(parseAuthenticated("nope")).toBeUndefined();
  });

  it("explains how to fix each state", () => {
    expect(cursorCliProblem({ state: "ready", binary: "/x" })).toBeUndefined();
    expect(cursorCliProblem({ state: "missing" })).toContain(
      "curl https://cursor.com/install -fsS | bash",
    );
    expect(cursorCliProblem({ state: "signed_out", binary: "/x" })).toContain("`agent login`");
    expect(cursorCliProblem({ state: "error", binary: "/x", message: "boom" })).toContain("boom");
  });
});

describe("AcpConnection", { timeout: SPAWN_TIMEOUT_MS }, () => {
  const script = (source: string) => ({
    command: process.execPath,
    args: ["-e", source],
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? "" },
  });

  it("frames split and batched lines, answers requests and forwards notifications", async () => {
    const notes: unknown[] = [];
    const conn = AcpConnection.spawn({
      ...script(`
        let buf = "";
        process.stdin.on("data", (d) => {
          buf += d;
          const lines = buf.split("\\n"); buf = lines.pop();
          for (const line of lines) {
            const m = JSON.parse(line);
            if (m.method === "ping") {
              const out = JSON.stringify({ jsonrpc: "2.0", method: "note", params: { n: 1 } }) + "\\n" +
                JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ask", params: {} }) + "\\n" +
                JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { pong: true } }) + "\\n";
              process.stdout.write(out.slice(0, 7));
              setTimeout(() => process.stdout.write(out.slice(7)), 20);
            }
            if (m.id === 99) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "answered", params: m.result }) + "\\n");
            if (m.method === "fail") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "Authentication required" } }) + "\\n");
          }
        });
      `),
      onNotification: (method, params) => notes.push({ method, params }),
      onRequest: async (method) => ({ handled: method }),
    });
    expect(await conn.request("ping", {})).toEqual({ pong: true });
    await expect(conn.request("fail", {})).rejects.toMatchObject({
      code: -32000,
      message: "Authentication required",
    });
    await expect(conn.request("fail", {})).rejects.toBeInstanceOf(AcpRpcError);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notes).toEqual([
      { method: "note", params: { n: 1 } },
      { method: "answered", params: { handled: "ask" } },
    ]);
    await conn.close();
    expect(conn.closed).toBe(true);
  });

  it("times out requests and rejects pending ones when the process exits", async () => {
    const exits: unknown[] = [];
    const conn = AcpConnection.spawn({
      ...script(
        `process.stdin.on("data", (d) => { if (String(d).includes("die")) { console.error("fatal: boom"); process.exit(4); } });`,
      ),
      onExit: (exit) => exits.push(exit),
    });
    await expect(conn.request("slow", {}, { timeoutMs: 50 })).rejects.toBeInstanceOf(
      AcpTimeoutError,
    );
    const pending = conn.request("die", {});
    await expect(pending).rejects.toBeInstanceOf(AcpClosedError);
    await expect(pending).rejects.toThrow(/exited \(code 4\): fatal: boom/);
    await expect(conn.request("after", {})).rejects.toBeInstanceOf(AcpClosedError);
    expect(exits).toEqual([{ code: 4, signal: null }]);
  });

  it("reports a command that can't start", async () => {
    const conn = AcpConnection.spawn({
      command: "/nonexistent/agent",
      args: [],
      cwd: tmpdir(),
      env: {},
    });
    await expect(conn.request("initialize", {})).rejects.toThrow(/could not start/);
  });
});
