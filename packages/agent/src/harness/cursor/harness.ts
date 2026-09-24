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
import { type Logger, silentLogger, TOOL_NAME_RE, type ToolSpec } from "@ddl/core";
import { TOOL } from "../../tools/contracts";
import { createWorkspaceTools } from "../builtin-tools";
import type { Harness, HarnessSession, HarnessSessionOptions } from "../types";
import { AcpConnection } from "./acp";
import { cliEnvironment, cursorCliProblem, findCursorCli } from "./cli";
import { buildAgentsMd } from "./instructions";
import { McpBridge } from "./mcp-bridge";
import { CursorHarnessSession, describeError } from "./session";
import {
  type CliPermissions,
  type CursorHome,
  cliPermissions,
  createSessionDirs,
  cursorHome,
  prepareCursorHome,
  readUserMcpServers,
  removeAcpSession,
  removeSessionDirs,
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
}

const SERVER_NAME = "ddl";
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

  async createSession(options: HarnessSessionOptions): Promise<HarnessSession> {
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

    const env = this.options.env ?? process.env;
    const userHome = this.options.userHome ?? os.homedir();
    const binary = findCursorCli({
      ...(this.options.binary ? { binary: this.options.binary } : {}),
      env,
      homeDir: userHome,
    });
    if (!binary) throw new Error(cursorCliProblem({ state: "missing" }));

    const userServers = await readUserMcpServers(userHome, logger);
    const serverName = userServers.includes(SERVER_NAME)
      ? `${SERVER_NAME}-${randomBytes(3).toString("hex")}`
      : SERVER_NAME;
    const permissions = cliPermissions(serverName, userServers);
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
    const dirs = await createSessionDirs(this.home, options.sessionId, { agentsMd, permissions });
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
      spawn: (handlers) =>
        AcpConnection.spawn({
          command: binary,
          args: [...(this.options.binaryArgs ?? []), "acp"],
          cwd: dirs.workspace,
          env: cliEnv,
          logger,
          ...handlers,
        }),
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
      await session.start(registration);
      if (options.signal?.aborted) throw new Error("Session creation aborted");
    } catch (error) {
      await session.dispose();
      throw new Error(`Cursor harness: ${describeError(error)}`);
    }
    logger.debug("session ready", { tools: tools.map((t) => t.name) });
    return session;
  }

  /** Stops accepting sessions; shared resources close once the open sessions are disposed. */
  async dispose(): Promise<void> {
    this.retired = true;
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

function validateTools(tools: readonly ToolSpec[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME_RE.test(tool.name)) throw new Error(`Invalid tool name "${tool.name}"`);
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}"`);
    seen.add(tool.name);
    const type = (tool.parameters as { type?: unknown }).type;
    if (type !== undefined && type !== "object") {
      throw new Error(`Tool "${tool.name}": parameters must be an object schema`);
    }
  }
}
