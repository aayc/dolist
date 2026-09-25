/**
 * Glue to the packages the daemon composes: storage, connectors, the agent stack and sync.
 */
import { mkdir } from "node:fs/promises";
import type { AgentRuntime, ExecutionProvider, LlmClient } from "@ddl/agent";
import {
  type ConnectorToolSource,
  createConnectorManager,
  EMPTY_CONNECTORS_CONFIG,
  loadConnectorsConfig,
} from "@ddl/connectors";
import {
  type AppSettings,
  agentModel,
  DEFAULT_SETTINGS,
  type Logger,
  mergeSettings,
} from "@ddl/core";
import {
  createStorageProvider,
  createSyncTarget,
  type StorageProvider,
  SyncEngine,
  type SyncTargetConfig,
  searchVault,
} from "@ddl/storage";
import type { DaemonConfig } from "./config";
import { errorMessage } from "./errors";
import { NullExecutionProvider } from "./null-execution";
import { NullAgentRuntime } from "./null-runtime";
import type { VaultSearch } from "./search";

type AgentModule = typeof import("@ddl/agent");

/** Code defaults overlaid with daemon config, so `DDL_MODEL` applies until the vault overrides it. */
export function settingsDefaults(config: Pick<DaemonConfig, "model">): AppSettings {
  return mergeSettings(DEFAULT_SETTINGS, {
    agent: { model: config.model, judgeModel: config.model },
  });
}

export async function createVaultStorage(
  config: Pick<DaemonConfig, "vaultPath">,
  logger: Logger,
): Promise<StorageProvider> {
  await mkdir(config.vaultPath, { recursive: true });
  return createStorageProvider(
    { kind: "local", root: config.vaultPath },
    { logger: logger.child({ component: "storage" }) },
  );
}

export async function createConnectors(
  config: Pick<DaemonConfig, "mcpConfigPath">,
  logger: Logger,
): Promise<ConnectorToolSource> {
  const log = logger.child({ component: "connectors" });
  try {
    return createConnectorManager(await loadConnectorsConfig(config.mcpConfigPath), {
      logger: log,
    });
  } catch (error) {
    log.error("Could not load MCP connectors; continuing without them", {
      error: errorMessage(error),
    });
    return createConnectorManager(EMPTY_CONNECTORS_CONFIG, { logger: log });
  }
}

export interface AgentStackOptions {
  config: Pick<DaemonConfig, "agentMode" | "home" | "model" | "execution">;
  env: Record<string, string | undefined>;
  /** The vault as the agent should see it (attributed so its writes are tagged `agent`). */
  storage: StorageProvider;
  settings: AppSettings;
  connectors: ConnectorToolSource;
  logger: Logger;
}

export interface AgentStack {
  runtime: AgentRuntime;
  /** Owned by the daemon: dispose on shutdown. */
  execution: ExecutionProvider | null;
}

/**
 * Creates the agent runtime and its dependencies. Never throws: if @ddl/agent fails to load or the
 * runtime cannot be created, a NullAgentRuntime reports the problem and the vault stays usable.
 */
export async function createAgentStack(options: AgentStackOptions): Promise<AgentStack> {
  const { config, logger, settings, connectors } = options;
  const unavailable = (problem: string): AgentStack => ({
    runtime: new NullAgentRuntime({
      model: agentModel(settings.agent),
      enabled: settings.agent.enabled,
      connectors,
      problem,
      storage: options.storage,
      logger: logger.child({ component: "agent" }),
    }),
    execution: null,
  });

  // Loaded lazily so a broken agent build degrades the agent instead of taking down the vault.
  let agent: AgentModule;
  try {
    agent = await import("@ddl/agent");
  } catch (error) {
    logger.error("Could not load the agent runtime", { error: errorMessage(error) });
    return unavailable(`The agent runtime failed to load: ${errorMessage(error)}`);
  }

  const execution =
    config.agentMode === "off"
      ? new NullExecutionProvider(config.home)
      : await createExecution(agent, config, logger);
  const llm =
    config.agentMode === "live"
      ? createLlmClient(agent, options.env, config.model, logger)
      : undefined;

  try {
    const runtime = await agent.createAgentRuntime({
      mode: config.agentMode,
      storage: options.storage,
      settings,
      home: config.home,
      execution,
      connectors,
      logger: logger.child({ component: "agent" }),
      ...(llm ? { llm } : {}),
    });
    return { runtime, execution };
  } catch (error) {
    logger.error("The agent runtime failed to initialize; continuing without agents", {
      error: errorMessage(error),
    });
    await execution.dispose().catch(() => undefined);
    return unavailable(`The agent runtime failed to start: ${errorMessage(error)}`);
  }
}

async function createExecution(
  agent: AgentModule,
  config: Pick<DaemonConfig, "home" | "execution">,
  logger: Logger,
): Promise<ExecutionProvider> {
  try {
    return await agent.createExecutionProvider(config.execution, {
      logger: logger.child({ component: "execution" }),
    });
  } catch (error) {
    logger.error("Execution provider unavailable; agents run without shell/browser/computer", {
      error: errorMessage(error),
    });
    return new NullExecutionProvider(config.home);
  }
}

/**
 * Absent key: the runtime starts degraded and explains the fix in `status().problem`.
 * `DDL_OPENROUTER_BASE_URL` points it at another OpenAI-compatible endpoint (e.g. `pnpm dev:fake`).
 */
function createLlmClient(
  agent: AgentModule,
  env: Record<string, string | undefined>,
  model: string,
  logger: Logger,
): LlmClient | undefined {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    logger.warn(
      "OPENROUTER_API_KEY is not set: the Pi harness, the LLM safety judge and the web tools are unavailable until it is added (the Cursor CLI harness runs without it)",
    );
    return undefined;
  }
  const baseUrl = env.DDL_OPENROUTER_BASE_URL?.trim();
  try {
    return agent.createOpenRouterClient({
      apiKey,
      defaultModel: model,
      logger: logger.child({ component: "llm" }),
      ...(baseUrl ? { baseUrl } : {}),
    });
  } catch (error) {
    logger.error("Could not create the OpenRouter client", { error: errorMessage(error) });
    return undefined;
  }
}

export interface SyncHandle {
  engine: SyncEngine;
  target: StorageProvider;
}

/** A sync engine for the configured target, or null when sync is off. */
export async function createSync(options: {
  target: SyncTargetConfig;
  primary: StorageProvider;
  logger: Logger;
}): Promise<SyncHandle | null> {
  if (options.target.kind === "none") return null;
  const logger = options.logger.child({ component: "sync" });
  const target = await createSyncTarget(options.target, { logger });
  if (!target) return null;
  return {
    engine: new SyncEngine({
      primary: options.primary,
      target,
      logger,
      // Machine-local agent scratch data must never leave this machine.
      exclude: [".daily-do-list/state/tasks"],
    }),
    target,
  };
}

export function resolveVaultSearch(storage: StorageProvider): VaultSearch {
  return (query, limit) => searchVault(storage, query, { limit });
}
