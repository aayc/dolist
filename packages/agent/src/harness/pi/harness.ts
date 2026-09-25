/**
 * Harness backed by Pi's coding-agent SDK. Sessions are hermetic: Pi's global config dir is never
 * read (agentDir is `${home}/pi`), no extensions/skills/prompt templates/context files are
 * discovered, nothing is persisted, and the only extension loaded is our safety gate.
 */
import { join } from "node:path";
import { type Logger, silentLogger, TOOL_NAME_RE, type ToolSpec } from "@ddl/core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Harness, HarnessSession, HarnessSessionOptions } from "../types";
import { createBuiltinTools } from "./builtins";
import { createGateExtension, GATE_EXTENSION_PATH } from "./gate";
import { ToolCallLedger } from "./ledger";
import { OPENROUTER_PROVIDER, resolveOpenRouterModel, toPiThinkingLevel } from "./model";
import { PiHarnessSession, type SessionLifecycle } from "./session";
import { type AnyToolDefinition, guardDefinition, toolSpecToDefinition } from "./tools";
import { seedTranscript } from "./transcript";

export interface PiHarnessOptions {
  /** OpenRouter API key. Held in memory only. */
  apiKey: string;
  /** DDL_HOME. Pi's isolated agent dir is `${home}/pi`. */
  home: string;
  logger?: Logger;
  /** OpenRouter attribution (`X-Title`, `HTTP-Referer`). */
  appName?: string;
  appUrl?: string;
  /** OpenAI-compatible endpoint replacing OpenRouter's (e.g. the fake used by tests and `dev:fake`). */
  baseUrl?: string;
  /** Pi's automatic retries of failed model requests. Default: Pi's (3 retries, from 2 s). */
  retry?: { maxRetries?: number; baseDelayMs?: number };
}

/** Seams for tests (e.g. an in-process faux provider instead of OpenRouter). */
export interface PiHarnessDeps {
  createModelRuntime?: (agentDir: string) => Promise<ModelRuntime>;
  resolveModel?: (modelId: string, runtime: ModelRuntime) => Model<Api>;
  ripgrepAvailable?: () => boolean;
}

/** Settings for every session; the in-memory manager never touches disk. */
const PI_SETTINGS = {
  cacheWarming: "off",
  enableInstallTelemetry: false,
  enableAnalytics: false,
  enableSkillCommands: false,
  quietStartup: true,
} as const;

export class PiHarness implements Harness {
  readonly name = "pi";
  private readonly options: PiHarnessOptions;
  private readonly deps: PiHarnessDeps;
  private readonly agentDir: string;
  private readonly logger: Logger;
  private runtime: Promise<ModelRuntime> | undefined;

  constructor(options: PiHarnessOptions, deps: PiHarnessDeps = {}) {
    if (!options.apiKey) throw new Error("createPiHarness: apiKey is required");
    if (!options.home) throw new Error("createPiHarness: home is required");
    this.options = options;
    this.deps = deps;
    this.agentDir = join(options.home, "pi");
    this.logger = (options.logger ?? silentLogger).child({ harness: "pi" });
  }

  async createSession(options: HarnessSessionOptions): Promise<HarnessSession> {
    if (options.signal?.aborted) throw new Error("Session creation aborted");
    validateToolNames(options.tools);
    const logger = this.logger.child({ sessionId: options.sessionId, role: options.role });
    const runtime = await this.modelRuntime();
    const model = (this.deps.resolveModel ?? this.resolveModel)(options.model, runtime);
    const ledger = new ToolCallLedger();
    const lifecycle: SessionLifecycle = { closed: false };
    const definitions = this.buildTools(options, ledger, logger);
    const toolNames = definitions.map((d) => d.name);

    let gateInstalled = false;
    const retry = this.options.retry;
    const settingsManager = SettingsManager.inMemory(
      retry ? { ...PI_SETTINGS, retry: { ...retry } } : PI_SETTINGS,
    );
    const guidelines = toolGuidelines(options.tools);
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => options.systemPrompt,
      appendSystemPromptOverride: () => (guidelines ? [guidelines] : []),
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
      promptsOverride: () => ({ prompts: [], diagnostics: [] }),
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter((e) => e.path === GATE_EXTENSION_PATH),
      }),
      extensionFactories: [
        createGateExtension({
          sessionId: options.sessionId,
          role: options.role,
          specs: new Map(options.tools.map((spec) => [spec.name, spec])),
          beforeToolCall: options.beforeToolCall,
          ledger,
          isClosed: () => lifecycle.closed,
          onInstalled: () => {
            gateInstalled = true;
          },
          logger,
        }),
      ],
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.inMemory(options.cwd);
    if (options.transcript?.length) {
      seedTranscript(sessionManager, options.transcript, model, Date.now());
    }
    const { session, extensionsResult } = await createAgentSession({
      cwd: options.cwd,
      agentDir: this.agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: toPiThinkingLevel(options.thinking),
      tools: toolNames,
      customTools: definitions,
      resourceLoader,
      sessionManager,
      settingsManager,
    });

    // Fail closed: without the gate hook Pi would execute tools unchecked.
    const active = [...session.getActiveToolNames()].sort();
    const problem = !gateInstalled
      ? `safety gate failed to load: ${extensionsResult.errors.map((e) => e.error).join("; ") || "unknown error"}`
      : JSON.stringify(active) !== JSON.stringify([...toolNames].sort())
        ? `unexpected active tools ${JSON.stringify(active)}`
        : undefined;
    if (problem) {
      session.dispose();
      throw new Error(`Pi harness: ${problem}`);
    }
    if (options.signal?.aborted) {
      session.dispose();
      throw new Error("Session creation aborted");
    }

    logger.debug("session created", {
      model: model.id,
      thinking: session.thinkingLevel,
      tools: toolNames,
    });
    return new PiHarnessSession({
      id: options.sessionId,
      session,
      ledger,
      lifecycle,
      logger,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  private buildTools(
    options: HarnessSessionOptions,
    ledger: ToolCallLedger,
    logger: Logger,
  ): AnyToolDefinition[] {
    const builtins = createBuiltinTools({
      cwd: options.cwd,
      builtins: options.builtinTools,
      logger,
      ...(this.deps.ripgrepAvailable ? { ripgrepAvailable: this.deps.ripgrepAvailable } : {}),
    });
    const builtinNames = new Set(builtins.map((d) => d.name));
    const clash = options.tools.find((spec) => builtinNames.has(spec.name));
    if (clash) throw new Error(`Tool "${clash.name}" conflicts with an enabled built-in tool`);
    const custom = options.tools.map((spec) => toolSpecToDefinition(spec, { ledger, logger }));
    return [...builtins, ...custom].map((definition) => guardDefinition(definition, ledger));
  }

  private modelRuntime(): Promise<ModelRuntime> {
    this.runtime ??= (this.deps.createModelRuntime ?? this.createModelRuntime)(this.agentDir).catch(
      (error: unknown) => {
        this.runtime = undefined;
        throw error;
      },
    );
    return this.runtime;
  }

  private readonly createModelRuntime = async (agentDir: string): Promise<ModelRuntime> => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false,
    });
    await runtime.setRuntimeApiKey(OPENROUTER_PROVIDER, this.options.apiKey);
    return runtime;
  };

  private readonly resolveModel = (modelId: string, runtime: ModelRuntime): Model<Api> =>
    resolveOpenRouterModel(modelId, runtime, {
      ...(this.options.appName ? { appName: this.options.appName } : {}),
      ...(this.options.appUrl ? { appUrl: this.options.appUrl } : {}),
      ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
    });
}

function validateToolNames(tools: readonly ToolSpec[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME_RE.test(tool.name)) throw new Error(`Invalid tool name "${tool.name}"`);
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name "${tool.name}"`);
    seen.add(tool.name);
  }
}

/** Pi drops tool prompt guidelines when the system prompt is overridden, so we append them. */
function toolGuidelines(tools: readonly ToolSpec[]): string | undefined {
  const lines = tools.flatMap((tool) =>
    (tool.promptGuidelines ?? []).map((line) => `- ${tool.name}: ${line.trim()}`),
  );
  return lines.length > 0 ? `Tool usage guidelines:\n${lines.join("\n")}` : undefined;
}
