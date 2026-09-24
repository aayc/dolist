import { type Logger, silentLogger } from "@ddl/core";
import { NotImplementedError } from "../errors";
import type {
  ExecutionCapabilities,
  ExecutionConfig,
  ExecutionProvider,
  ShellExecutor,
  Workspace,
} from "../types";

export type CloudExecutionConfig = Extract<ExecutionConfig, { kind: "cloud" }>;

const NOT_IMPLEMENTED = "The cloud execution provider is not implemented yet; use `local`.";

/**
 * Placeholder for running the agent's effects in a remote sandbox VM instead of this Mac.
 *
 * Planned design — the agent loop keeps running in the daemon; only effects move:
 * - One VM (or container) per task workspace, provisioned through `endpoint` and torn down on
 *   `dispose()`/idle. `prepareWorkspace(key)` maps to a directory on that VM.
 * - Shell: commands are executed over an authenticated HTTPS API with streamed output (same
 *   semantics as the local shell: timeout, abort kills the process group, head+tail truncation).
 * - Browser: a Chrome inside the VM exposed as CDP-over-WebSocket, which playwright-core attaches
 *   to (`chromium.connectOverCDP`); sessions, snapshots, refs and the screencast then work exactly
 *   like the local controller.
 * - Computer: the VM desktop streamed VNC-style — frames for the UI plus mouse/keyboard input
 *   messages — behind the same `ComputerController` (coordinates in screenshot pixels).
 * - Auth: a bearer key read at runtime from the environment variable named by `apiKeyEnv`
 *   (the config never holds the key itself), sent on every request and never logged.
 *
 * Because it implements the same interfaces, `createExecutionTools` works unchanged. Until then
 * every capability is off and the methods throw {@link NotImplementedError}.
 */
export class CloudExecutionProvider implements ExecutionProvider {
  readonly id = "cloud";
  readonly capabilities: ExecutionCapabilities = { shell: false, browser: false, computer: false };
  readonly shell: ShellExecutor = {
    exec: () => Promise.reject(new NotImplementedError(NOT_IMPLEMENTED)),
  };
  readonly browser = undefined;
  readonly computer = undefined;
  readonly endpoint: string;
  private readonly apiKeyEnv: string;
  private readonly logger: Logger;

  constructor(config: CloudExecutionConfig, options: { logger?: Logger } = {}) {
    this.endpoint = config.endpoint;
    this.apiKeyEnv = config.apiKeyEnv;
    this.logger = options.logger ?? silentLogger;
    this.logger.warn("cloud execution provider selected, but it is not implemented yet", {
      endpoint: this.endpoint,
      apiKeyEnv: this.apiKeyEnv,
    });
  }

  prepareWorkspace(_key: string): Promise<Workspace> {
    return Promise.reject(new NotImplementedError(NOT_IMPLEMENTED));
  }

  /** Nothing is allocated yet, so there is nothing to release. */
  async dispose(): Promise<void> {}
}
