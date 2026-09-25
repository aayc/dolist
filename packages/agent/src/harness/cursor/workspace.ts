/**
 * What the Cursor harness keeps on disk, all under `<DDL_HOME>/cursor/` (0700):
 *
 * - `config/`: the CLI's config dir (`CURSOR_CONFIG_DIR`) for every session of the harness. Its
 *   `cli-config.json` is ours: allowlist approvals with an empty allowlist except our MCP server,
 *   the deny list below, web search always asks, sandboxed shell. The user's own CLI config (with
 *   its allowlist and approval mode) never applies. The CLI adds its state (sign-in details,
 *   caches, `acp-sessions/<id>` transcripts, which are deleted with their session).
 * - `sessions/<id>-<random>/`: one per session. `workspace/` is the agent's cwd with our
 *   `AGENTS.md` (the system prompt) and `.cursor/cli.json` (the deny list again, per project);
 *   `data/` is the CLI's data dir (`CURSOR_DATA_DIR`); `cli.pid` is the CLI process it runs.
 *   Neither directory is the task workspace: our own file and shell tools work there.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@ddl/core";

const execFileAsync = promisify(execFile);
/** In a session's root: the pid of the CLI process it runs. */
const CLI_PID_FILE = "cli.pid";

/** Built-in tool categories the CLI must never run itself (deny wins over any allowlist). */
export const DENIED_BUILTINS = [
  "Read(**)",
  "Read(/**)",
  "Write(**)",
  "Write(/**)",
  "Shell(*)",
  "WebFetch(*)",
] as const;

/** `Mcp(server:tool)` tokens break on these characters, so such names can't be listed. */
const MCP_NAME_RE = /^[^\s():*]+$/;
const MAX_USER_SERVERS = 200;

export interface CursorHome {
  root: string;
  configDir: string;
  sessionsDir: string;
}

export interface SessionDirs {
  root: string;
  workspace: string;
  data: string;
}

export interface CliPermissions {
  allow: string[];
  deny: string[];
}

/** Sessions of every harness instance in this process; stale-file cleanup skips them. */
const liveSessionRoots = new Set<string>();
const liveAcpSessions = new Set<string>();

export function cursorHome(home: string): CursorHome {
  const root = path.join(home, "cursor");
  return { root, configDir: path.join(root, "config"), sessionsDir: path.join(root, "sessions") };
}

export function cliPermissions(serverName: string, userServers: readonly string[]): CliPermissions {
  const deny: string[] = [...DENIED_BUILTINS];
  for (const name of userServers) if (name !== serverName) deny.push(`Mcp(${name}:*)`);
  return { allow: [`Mcp(${serverName}:*)`], deny };
}

/**
 * Names of the MCP servers in the user's `~/.cursor/mcp.json`. The CLI loads them into every
 * session with their tools pre-approved, so each one is denied by name.
 */
export async function readUserMcpServers(userHome: string, logger?: Logger): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(userHome, ".cursor", "mcp.json"), "utf8");
  } catch {
    return [];
  }
  if (!text.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    logger?.warn("~/.cursor/mcp.json is not valid JSON; its servers can't be denied by name");
    return [];
  }
  const servers =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).mcpServers
      : undefined;
  if (typeof servers !== "object" || servers === null) return [];
  const names = Object.keys(servers).slice(0, MAX_USER_SERVERS);
  const unusable = names.filter((name) => !MCP_NAME_RE.test(name));
  if (unusable.length > 0) {
    logger?.warn("Some MCP servers in ~/.cursor/mcp.json can't be denied by name", {
      count: unusable.length,
    });
  }
  return names.filter((name) => MCP_NAME_RE.test(name));
}

/** Creates the harness directories, writes the CLI config and removes stale sessions. */
export async function prepareCursorHome(
  home: CursorHome,
  permissions: CliPermissions,
  logger?: Logger,
): Promise<void> {
  for (const dir of [home.root, home.configDir, home.sessionsDir]) await ensurePrivateDir(dir);
  await writeCliConfig(home.configDir, permissions);
  await removeStale(home, logger);
}

/** Merges our settings into the CLI's config file, keeping the state the CLI stores there. */
export async function writeCliConfig(configDir: string, permissions: CliPermissions) {
  const file = path.join(configDir, "cli-config.json");
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable: start over.
  }
  const config = {
    ...existing,
    version: 1,
    permissions,
    approvalMode: "allowlist",
    autoAcceptWebSearch: false,
    sandbox: { mode: "enabled", networkAccess: "user_config_with_defaults" },
  };
  await writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A session's folder: the CLI's workspace (with the project permission config, and AGENTS.md when
 * given; a prewarmed CLI gets it with `writeAgentsMd` before its session starts) and its data dir.
 */
export async function createSessionDirs(
  home: CursorHome,
  sessionId: string,
  files: { agentsMd?: string; permissions: CliPermissions },
): Promise<SessionDirs> {
  const root = path.join(
    home.sessionsDir,
    `${sanitize(sessionId)}-${randomBytes(4).toString("hex")}`,
  );
  const dirs: SessionDirs = {
    root,
    workspace: path.join(root, "workspace"),
    data: path.join(root, "data"),
  };
  liveSessionRoots.add(root);
  try {
    for (const dir of [root, dirs.workspace, path.join(dirs.workspace, ".cursor"), dirs.data]) {
      await ensurePrivateDir(dir);
    }
    if (files.agentsMd !== undefined) await writeAgentsMd(dirs, files.agentsMd);
    await writeFileAtomic(
      path.join(dirs.workspace, ".cursor", "cli.json"),
      `${JSON.stringify({ permissions: files.permissions }, null, 2)}\n`,
    );
    return dirs;
  } catch (error) {
    await removeSessionDirs(dirs);
    throw error;
  }
}

export async function writeAgentsMd(dirs: SessionDirs, agentsMd: string): Promise<void> {
  await writeFileAtomic(path.join(dirs.workspace, "AGENTS.md"), agentsMd);
}

export async function removeSessionDirs(dirs: SessionDirs): Promise<void> {
  await rm(dirs.root, { recursive: true, force: true });
  liveSessionRoots.delete(dirs.root);
}

export function trackAcpSession(sessionId: string): void {
  liveAcpSessions.add(sessionId);
}

/** Deletes the transcript store the CLI keeps for an ACP session in our config dir. */
export async function removeAcpSession(home: CursorHome, sessionId: string): Promise<void> {
  liveAcpSessions.delete(sessionId);
  if (!isPlainName(sessionId)) return;
  await rm(path.join(home.configDir, "acp-sessions", sessionId), { recursive: true, force: true });
}

/** Records the CLI process a session runs, so a later daemon can stop it if this one dies first. */
export async function recordCliProcess(dirs: SessionDirs, pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  await writeFileAtomic(path.join(dirs.root, CLI_PID_FILE), `${pid}\n`);
}

/**
 * Stops the CLI processes of sessions no live harness owns: left running by a daemon that was
 * killed or crashed (the CLI doesn't always exit when its input closes). A recorded pid is only
 * signalled while that process still works inside the session's folder, so a reused pid is safe.
 */
export async function stopLeftoverClis(home: CursorHome, logger?: Logger): Promise<number> {
  let stopped = 0;
  for (const name of await readdir(home.sessionsDir).catch(() => [])) {
    const root = path.join(home.sessionsDir, name);
    if (liveSessionRoots.has(root)) continue;
    const pid = Number.parseInt(
      await readFile(path.join(root, CLI_PID_FILE), "utf8").catch(() => ""),
      10,
    );
    if (!Number.isInteger(pid) || pid <= 1 || !(await worksInside(pid, root))) continue;
    signalGroup(pid, "SIGTERM");
    if (!(await exitsWithin(pid, 2_000))) signalGroup(pid, "SIGKILL");
    stopped++;
    logger?.warn("Stopped a Cursor CLI process that a previous daemon left running", { pid });
  }
  return stopped;
}

async function worksInside(pid: number, root: string): Promise<boolean> {
  const cwd = await processCwd(pid);
  if (!cwd) return false;
  const [resolvedCwd, resolvedRoot] = await Promise.all([
    realpath(cwd).catch(() => cwd),
    realpath(root).catch(() => root),
  ]);
  return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}${path.sep}`);
}

/** A process's working directory (`/proc` on Linux, `lsof` elsewhere), or null. */
async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === "linux") return readlink(`/proc/${pid}/cwd`).catch(() => null);
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      timeout: 2_000,
    });
    const line = stdout.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function exitsWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function removeStale(home: CursorHome, logger?: Logger): Promise<void> {
  await stopLeftoverClis(home, logger);
  const stale: string[] = [];
  for (const name of await readdir(home.sessionsDir).catch(() => [])) {
    const dir = path.join(home.sessionsDir, name);
    if (!liveSessionRoots.has(dir)) stale.push(dir);
  }
  const stores = path.join(home.configDir, "acp-sessions");
  for (const name of await readdir(stores).catch(() => [])) {
    if (!liveAcpSessions.has(name) && isPlainName(name)) stale.push(path.join(stores, name));
  }
  await Promise.all(stale.map((dir) => rm(dir, { recursive: true, force: true })));
  if (stale.length > 0)
    logger?.debug("removed stale Cursor session files", { count: stale.length });
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, file);
}

function sanitize(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "session";
}

function isPlainName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
}
