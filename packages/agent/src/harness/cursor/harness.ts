/**
 * Harness backed by the Cursor CLI's agent over ACP (`agent acp`), signed in with the user's own
 * Cursor account. One CLI process per session. The CLI's built-in tools are disabled (a deny list
 * in a private CLI config and per-session project config, see `workspace.ts`); every tool the
 * agent uses is ours, served over a local MCP endpoint that routes each call through
 * `beforeToolCall`, the safety gate. Web search/fetch requests from the CLI go through the gate
 * too, and a policy monitor stops the session if a disabled built-in ever produces a result.
 */

import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import os from "node:os";
import { type Logger, silentLogger, type ToolSpec, validateToolNames } from "@ddl/core";
import { TOOL } from "../../tools/contracts";
import { createWorkspaceTools } from "../builtin-tools";
import type { Harness, HarnessSession, HarnessSessionOptions } from "../types";
import { AcpConnection } from "./acp";
import { cliEnvironment, cursorCliProblem, findCursorCli } from "./cli";
import { buildAgentsMd } from "./instructions";
import { McpBridge } from "./mcp-bridge";
import { CursorHarnessSession, describeError, initializeCli, type WarmCli } from "./session";
import {
  type CliPermissions,
  type CursorHome,
  cliPermissions,
  createSessionDirs,
  cursorHome,
  prepareCursorHome,
  readUserMcpServers,
  recordCliProcess,
  removeAcpSession,
  removeSessionDirs,
  type SessionDirs,
  stopLeftoverClis,
  writeAgentsMd,
  writeCliConfig,
} from "./workspace";

export interface CursorHarnessOptions {
  /** DDL_HOME. The harness keeps its files in `${home}/cursor`. */
  home: string;
  logger?: Logger;
  /** The CLI: a path or a command name. Default: `agent`, then `cursor-agent` (PATH, ~/.local/bin). */
  binary?: string;
  /** Arguments placed before `acp` (tests run a script through `node`). */
  binaryArgs?: readonly string[];
  /** Where PATH, HOME, locale and proxy settings for the CLI come from. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The user's home, for `~/.cursor/mcp.json` and `~/.local/bin`. Default: `os.homedir()`. */
  userHome?: string;
  /** Idle sessions end their CLI process after this long and resume on the next prompt. Default 5 min. */
  idleTimeoutMs?: number;
  /** Tool calls still running after this long are answered as "still running". Default 45 s. */
  detachAfterMs?: number;
  /** Timeout of the CLI's control requests (initialize, session/new, session/load). Default 90 s. */
  requestTimeoutMs?: number;
  /** How long a cancelled turn may take to stop before the CLI is stopped. Default 10 s. */
  cancelGraceMs?: number;
  /** A prewarmed CLI no session has taken is stopped after this long. Default 2 min. */
  spareTtlMs?: number;
}

/** A CLI started ahead of its session (`prewarm`), with what its session must match. */
interface WarmSpare extends WarmCli {
  dirs: SessionDirs;
  serverName: string;
  userServers: readonly string[];
  permissions: CliPermissions;
}

/** What a spare has started so far, to stop it at any point. */
interface SpareState {
  dropped: boolean;
  expiry?: ReturnType<typeof setTimeout>;
  conn?: AcpConnection;
  dirs?: SessionDirs;
}

type Spare = SpareState & { ready: Promise<WarmSpare> };

const SERVER_NAME = "ddl";
const DEFAULT_SPARE_TTL_MS = 2 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_DETACH_AFTER_MS = 45_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;

export class CursorHarness implements Harness {
  readonly name = "cursor";
  private readonly options: CursorHarnessOptions;
  private readonly logger: Logger;
  private readonly home: CursorHome;
  private readonly sessions = new Set<CursorHarnessSession>();
  private spare: Spare | undefined;
  private bridge: McpBridge | undefined;
  private prepared: Promise<McpBridge> | undefined;
  private retired = false;
  private closing: Promise<void> | undefined;

  constructor(options: CursorHarnessOptions) {
    if (!options.home) throw new Error("createCursorHarness: home is required");
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child({ harness: "cursor" });
    this.home = cursorHome(options.home);
  }

  createSession(options: HarnessSessionOptions): Promise<HarnessSession> {
    return this.open(options, true);
  }

  /**
   * Starts and initializes a CLI for the next session ahead of time (the user is typing, so a task
   * may follow), which takes ~0.35 s off that session's ~3.5 s start, more on a busy or cold
   * machine. It can't go further: the CLI reads its folder's AGENTS.md during the process's first
   * `session/new` (the slow part), so that has to wait for the session's AGENTS.md. The spare runs
   * with the permission config from the start. One at a time, stopped after `spareTtlMs` without a
   * session. Resolves when it's ready; never rejects.
   */
  prewarm(): Promise<void> {
    if (this.retired) return Promise.resolve();
    const spare = this.spare ?? this.startSpare();
    this.armSpareExpiry(spare);
    return spare.ready.then(
      () => {},
      () => {},
    );
  }

  private async open(options: HarnessSessionOptions, useSpare: boolean): Promise<HarnessSession> {
    if (this.retired) throw new Error("Cursor harness: this harness has been replaced");
    if (options.signal?.aborted) throw new Error("Session creation aborted");
    validateTools(options.tools);
    const logger = this.logger.child({ sessionId: options.sessionId, role: options.role });
    const builtins = createWorkspaceTools({
      cwd: options.cwd,
      builtins: options.builtinTools,
      logger,
    });
    const builtinNames = new Set(builtins.map((tool) => tool.name));
    const clash = options.tools.find((spec) => builtinNames.has(spec.name));
    if (clash) throw new Error(`Tool "${clash.name}" conflicts with an enabled built-in tool`);
    const tools = [...builtins, ...options.tools];

    const { env, userHome, binary } = this.locateCli();
    const userServers = await readUserMcpServers(userHome, logger);
    const warm = useSpare ? await this.claimSpare(userServers) : undefined;
    const serverName = warm?.serverName ?? pickServerName(userServers);
    const permissions = warm?.permissions ?? cliPermissions(serverName, userServers);
    const bridge = await this.prepare(permissions);
    const webAllowed = tools.some((t) => t.name === TOOL.webSearch || t.name === TOOL.webFetch);
    const agentsMd = buildAgentsMd({
      systemPrompt: options.systemPrompt,
      serverName,
      tools,
      taskWorkspace: options.cwd,
      hasFileTools: builtins.some((t) => t.name !== TOOL.bash),
      hasShell: builtinNames.has(TOOL.bash),
      webAllowed,
    });
    let dirs: SessionDirs;
    if (warm) {
      dirs = warm.dirs;
      await writeAgentsMd(dirs, agentsMd);
    } else {
      dirs = await createSessionDirs(this.home, options.sessionId, { agentsMd, permissions });
    }
    const resolved = await realpath(dirs.workspace);
    const cliEnv = cliEnvironment(env, {
      CURSOR_CONFIG_DIR: this.home.configDir,
      CURSOR_DATA_DIR: dirs.data,
    });

    let unregister = () => {};
    const session: CursorHarnessSession = new CursorHarnessSession({
      options,
      tools,
      builtinNames,
      serverName,
      workspace: dirs.workspace,
      workspaceRoots: [...new Set([dirs.workspace, resolved])],
      webAllowed,
      spawn: (handlers) => {
        const conn = AcpConnection.spawn({
          command: binary,
          args: [...(this.options.binaryArgs ?? []), "acp"],
          cwd: dirs.workspace,
          env: cliEnv,
          logger,
          ...handlers,
        });
        recordCliProcess(dirs, conn.pid).catch((error: unknown) => {
          logger.debug("couldn't record the CLI process", { error: describeError(error) });
        });
        return conn;
      },
      idleTimeoutMs: this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      detachAfterMs: this.options.detachAfterMs ?? DEFAULT_DETACH_AFTER_MS,
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      cancelGraceMs: this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
      logger,
      onClose: async (acpSessionId) => {
        unregister();
        this.sessions.delete(session);
        await removeSessionDirs(dirs);
        if (acpSessionId) await removeAcpSession(this.home, acpSessionId);
        if (this.retired && this.sessions.size === 0) await this.closeShared();
      },
    });
    const registration = bridge.register(session.tools);
    unregister = registration.unregister;
    this.sessions.add(session);
    try {
      await session.start(registration, warm);
      if (options.signal?.aborted) throw new Error("Session creation aborted");
    } catch (error) {
      await session.dispose();
      if (warm && !this.retired && !options.signal?.aborted) {
        logger.debug("The prewarmed Cursor CLI failed; starting another", {
          error: describeError(error),
        });
        return this.open(options, false);
      }
      throw new Error(`Cursor harness: ${describeError(error)}`);
    }
    logger.debug("session ready", { tools: tools.map((t) => t.name), prewarmed: !!warm });
    return session;
  }

  private locateCli(): { env: NodeJS.ProcessEnv; userHome: string; binary: string } {
    const env = this.options.env ?? process.env;
    const userHome = this.options.userHome ?? os.homedir();
    const binary = findCursorCli({
      ...(this.options.binary ? { binary: this.options.binary } : {}),
      env,
      homeDir: userHome,
    });
    if (!binary) throw new Error(cursorCliProblem({ state: "missing" }));
    return { env, userHome, binary };
  }

  // ── The prewarmed CLI ─────────────────────────────────────────────────────

  private startSpare(): Spare {
    const state: SpareState = { dropped: false };
    const spare: Spare = Object.assign(state, { ready: this.warmSpare(state) });
    spare.ready.catch((error: unknown) => {
      if (!spare.dropped) {
        this.logger.debug("Couldn't prewarm a Cursor CLI", { error: describeError(error) });
      }
      void this.dropSpare(spare);
    });
    this.spare = spare;
    return spare;
  }

  private async warmSpare(spare: SpareState): Promise<WarmSpare> {
    const { env, userHome, binary } = this.locateCli();
    const userServers = await readUserMcpServers(userHome, this.logger);
    const serverName = pickServerName(userServers);
    const permissions = cliPermissions(serverName, userServers);
    await this.prepare(permissions);
    spare.dirs = await createSessionDirs(this.home, "prewarmed", { permissions });
    const dirs = spare.dirs;
    this.checkSpare(spare);
    const conn = AcpConnection.spawn({
      command: binary,
      args: [...(this.options.binaryArgs ?? []), "acp"],
      cwd: dirs.workspace,
      env: cliEnvironment(env, {
        CURSOR_CONFIG_DIR: this.home.configDir,
        CURSOR_DATA_DIR: dirs.data,
      }),
      logger: this.logger,
      onExit: () => {
        if (this.spare === spare) void this.dropSpare(spare);
      },
    });
    spare.conn = conn;
    this.checkSpare(spare);
    await recordCliProcess(dirs, conn.pid);
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const { canResume, images } = await initializeCli(conn, timeoutMs);
    this.checkSpare(spare);
    return {
      conn,
      canResume,
      images,
      dirs,
      serverName,
      userServers,
      permissions,
    };
  }

  /** A spare stopped while it was starting cleans up what it had started. */
  private checkSpare(spare: SpareState): void {
    if (!spare.dropped) return;
    void this.dropSpare(spare, true);
    throw new Error("The prewarmed Cursor CLI was stopped");
  }

  /** The spare, if it's (or becomes) ready and still fits: the user's MCP servers are unchanged. */
  private async claimSpare(userServers: readonly string[]): Promise<WarmSpare | undefined> {
    const spare = this.spare;
    if (!spare) return undefined;
    this.spare = undefined;
    clearTimeout(spare.expiry);
    const warm = await spare.ready.catch(() => undefined);
    if (!warm || spare.dropped || warm.conn.closed || !sameItems(warm.userServers, userServers)) {
      await this.dropSpare(spare);
      return undefined;
    }
    return warm;
  }

  private async dropSpare(spare: SpareState, again = false): Promise<void> {
    if (spare.dropped && !again) return;
    spare.dropped = true;
    if (this.spare === spare) this.spare = undefined;
    clearTimeout(spare.expiry);
    await spare.conn?.close(0);
    if (spare.dirs) await removeSessionDirs(spare.dirs);
  }

  private armSpareExpiry(spare: SpareState): void {
    clearTimeout(spare.expiry);
    spare.expiry = setTimeout(
      () => void this.dropSpare(spare),
      this.options.spareTtlMs ?? DEFAULT_SPARE_TTL_MS,
    );
    spare.expiry.unref?.();
  }

  /**
   * Stops CLI processes that sessions of an earlier daemon left running (see `stopLeftoverClis`).
   * Also runs before the first session; call it at startup so they don't linger until then.
   */
  stopLeftovers(): Promise<number> {
    return stopLeftoverClis(this.home, this.logger);
  }

  /** Stops accepting sessions; shared resources close once the open sessions are disposed. */
  async dispose(): Promise<void> {
    this.retired = true;
    if (this.spare) await this.dropSpare(this.spare);
    if (this.sessions.size === 0) await this.closeShared();
  }

  /** Directories, CLI config and the MCP bridge. The config is rewritten for every session. */
  private async prepare(permissions: CliPermissions): Promise<McpBridge> {
    this.prepared ??= (async () => {
      await prepareCursorHome(this.home, permissions, this.logger);
      const bridge = new McpBridge({ serverName: "daily-do-list", logger: this.logger });
      await bridge.start();
      this.bridge = bridge;
      return bridge;
    })().catch((error: unknown) => {
      this.prepared = undefined;
      throw error;
    });
    const bridge = await this.prepared;
    await writeCliConfig(this.home.configDir, permissions);
    return bridge;
  }

  private closeShared(): Promise<void> {
    this.closing ??= this.bridge?.close() ?? Promise.resolve();
    return this.closing;
  }
}

/** Our MCP server's name: distinct from the user's servers, which the permission config denies. */
function pickServerName(userServers: readonly string[]): string {
  return userServers.includes(SERVER_NAME)
    ? `${SERVER_NAME}-${randomBytes(3).toString("hex")}`
    : SERVER_NAME;
}

function sameItems(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function validateTools(tools: readonly ToolSpec[]): void {
  validateToolNames(tools);
  for (const tool of tools) {
    const type = (tool.parameters as { type?: unknown }).type;
    if (type !== undefined && type !== "object") {
      throw new Error(`Tool "${tool.name}": parameters must be an object schema`);
    }
  }
}
