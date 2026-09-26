/**
 * This daemon's readiness to run the agent (`AgentStatusResponse.readiness`): whether its harness
 * can run (the Cursor CLI installed and signed in, or the Pi model credential present), a model
 * credential, the browser, desktop control and connectors. Everything is a boolean or a count:
 * never a credential, a path or an account detail. Probes run in the background (at start, when
 * the harness changes, and when the last result is stale) so reading the status never waits.
 */
import type { ExecutionConfig } from "@ddl/agent";
import type { ConnectorToolSource } from "@ddl/connectors";
import {
  type AgentHarnessKind,
  type AgentMode,
  type AgentReadiness,
  type AgentStatusResponse,
  errorMessage,
  type Logger,
  silentLogger,
} from "@ddl/core";

export interface HarnessProbe {
  ready: boolean;
  problem?: string;
  /** A model credential for this harness is present. */
  credential: boolean;
}

export interface ExecutionProbe {
  browser: boolean;
  computer: AgentReadiness["computer"];
}

export interface ReadinessProbes {
  harness(kind: AgentHarnessKind): Promise<HarnessProbe>;
  execution(): Promise<ExecutionProbe>;
}

export interface ReadinessMonitorOptions {
  mode: AgentMode;
  /** The configured harness (`settings.agent.harness`). */
  harness: () => AgentHarnessKind;
  connectors?: Pick<ConnectorToolSource, "status">;
  probes: ReadinessProbes;
  /** A probe brought a different answer. */
  onChange?: () => void;
  /** Results older than this are probed again on the next read. Default 5 minutes. */
  ttlMs?: number;
  now?: () => number;
  logger?: Logger;
}

const DEFAULT_TTL_MS = 5 * 60_000;

export class ReadinessMonitor {
  readonly #options: ReadinessMonitorOptions;
  readonly #now: () => number;
  #harness: { kind: AgentHarnessKind; probe: HarnessProbe } | undefined;
  #execution: ExecutionProbe | undefined;
  #probedAt = Number.NEGATIVE_INFINITY;
  #refreshing: Promise<void> | undefined;
  #stopped = false;

  constructor(options: ReadinessMonitorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The readiness as last probed (undefined until the first probe finished). A running agent's
   * own status is fresher for the browser and desktop, so it wins when given.
   */
  current(runtime?: AgentStatusResponse): AgentReadiness | undefined {
    const kind = this.#options.harness();
    const stale = this.#now() - this.#probedAt >= (this.#options.ttlMs ?? DEFAULT_TTL_MS);
    if (!this.#stopped && (stale || this.#harness?.kind !== kind)) void this.refresh();
    const harness = this.#harness?.kind === kind ? this.#harness.probe : undefined;
    if (!harness || !this.#execution) return undefined;
    const execution = fromRuntime(runtime) ?? this.#execution;
    const connectors = this.#options.connectors?.status() ?? runtime?.connectors ?? [];
    return {
      harness: {
        kind,
        ready: harness.ready,
        ...(harness.problem ? { problem: harness.problem } : {}),
      },
      modelCredential: harness.credential,
      browser: execution.browser,
      computer: execution.computer,
      connectors: {
        configured: connectors.filter((connector) => connector.state !== "disabled").length,
        connected: connectors.filter((connector) => connector.state === "connected").length,
      },
    };
  }

  /** Probes again now (one probe at a time). */
  refresh(): Promise<void> {
    this.#refreshing ??= this.#probe().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  stop(): void {
    this.#stopped = true;
  }

  async #probe(): Promise<void> {
    const { probes, logger = silentLogger } = this.#options;
    const kind = this.#options.harness();
    const before = JSON.stringify([this.#harness, this.#execution]);
    this.#probedAt = this.#now();
    const [harness, execution] = await Promise.all([
      this.#modeHarness(kind).catch(
        (error: unknown): HarnessProbe => ({
          ready: false,
          problem: `Couldn't check the agent harness (${errorMessage(error)}).`,
          credential: false,
        }),
      ),
      probes.execution().catch((error: unknown): ExecutionProbe => {
        logger.debug("Couldn't check the browser and desktop", { error: errorMessage(error) });
        return { browser: false, computer: "unsupported" };
      }),
    ]);
    if (this.#stopped) return;
    this.#harness = { kind, probe: harness };
    this.#execution = execution;
    if (JSON.stringify([this.#harness, this.#execution]) !== before) this.#options.onChange?.();
  }

  #modeHarness(kind: AgentHarnessKind): Promise<HarnessProbe> {
    switch (this.#options.mode) {
      case "mock":
        // The scripted agent needs no harness or model.
        return Promise.resolve({ ready: true, credential: true });
      case "off":
        return Promise.resolve({
          ready: false,
          problem: "The agent is off on this device (DDL_AGENT_MODE=off).",
          credential: false,
        });
      case "live":
        return this.#options.probes.harness(kind);
    }
  }
}

/** What a running agent reports about its browser and desktop, when it runs here. */
function fromRuntime(status: AgentStatusResponse | undefined): ExecutionProbe | undefined {
  if (!status || status.execution.provider === "none") return undefined;
  const { capabilities, computerAccess } = status.execution;
  if (capabilities.computer && !computerAccess) return undefined;
  return {
    browser: capabilities.browser,
    computer: !capabilities.computer
      ? "unsupported"
      : computerAccess?.accessibility && computerAccess.screenRecording
        ? "available"
        : "needs_permissions",
  };
}

/**
 * The real probes: the harness's own checks (the OpenRouter key's presence for Pi, `agent status`
 * for the Cursor CLI) and a throwaway execution provider for the browser and desktop. The agent
 * package loads on first use, as everywhere in the daemon.
 */
export function systemReadinessProbes(options: {
  env: Record<string, string | undefined>;
  execution: ExecutionConfig;
}): ReadinessProbes {
  const { env } = options;
  return {
    async harness(kind) {
      if (kind === "pi") {
        const credential = Boolean(env.OPENROUTER_API_KEY?.trim());
        return credential
          ? { ready: true, credential }
          : { ready: false, problem: "OPENROUTER_API_KEY is not set on this machine.", credential };
      }
      const cursor = await import("@ddl/agent/cursor");
      const binary = env.DDL_CURSOR_CLI?.trim() || undefined;
      const status = await cursor.checkCursorCli({
        ...(binary ? { binary } : {}),
        env: env as NodeJS.ProcessEnv,
      });
      const problem = cursor.cursorCliProblem(status);
      return {
        ready: status.state === "ready",
        ...(problem ? { problem } : {}),
        credential: status.state === "ready",
      };
    },
    async execution() {
      const agent = await import("@ddl/agent");
      const provider = await agent.createExecutionProvider(options.execution, {
        logger: silentLogger,
      });
      try {
        if (!provider.capabilities.computer || !provider.computerAccess) {
          return { browser: provider.capabilities.browser, computer: "unsupported" };
        }
        const access = await provider.computerAccess();
        return {
          browser: provider.capabilities.browser,
          computer:
            access?.accessibility && access.screenRecording ? "available" : "needs_permissions",
        };
      } finally {
        await provider.dispose().catch(() => undefined);
      }
    },
  };
}
