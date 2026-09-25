import { join } from "node:path";
import { type ComputerAccess, type ComputerHostApp, type Logger, silentLogger } from "@ddl/core";
import type { DrawingRenderer } from "../../drawings/renderer";
import type {
  AppController,
  BrowserController,
  ComputerController,
  ComputerPermissions,
  ExecutionCapabilities,
  ExecutionConfig,
  ExecutionProvider,
  Workspace,
} from "../types";
import { HelperClient, type SpawnHelper } from "./app-control/client";
import { HelperAppController } from "./app-control/controller";
import { LocalBrowserController } from "./browser";
import { type ResolvedBrowser, resolveBrowserExecutable } from "./browser-executable";
import { createComputerController } from "./computer-macos";
import { ChromiumDrawingRenderer } from "./drawing-renderer";
import { findHostApp } from "./host-app";
import { type CommandRunner, execFileRunner } from "./jxa";
import { LocalShellExecutor } from "./shell";
import { prepareLocalWorkspace } from "./workspace";

export type LocalExecutionConfig = Extract<ExecutionConfig, { kind: "local" }>;

/** A failed host-app lookup is retried after this long. */
const HOST_APP_RETRY_MS = 60_000;

export interface LocalProviderDeps {
  logger?: Logger;
  platform?: NodeJS.Platform;
  /** Override browser discovery (tests). */
  resolveBrowser?: (config: LocalExecutionConfig["browser"]) => ResolvedBrowser | undefined;
  /** System commands (`ps`, `osascript`…); tests script them. */
  runner?: CommandRunner;
  /** Starts the computer helper (tests: the fake helper). */
  spawnHelper?: SpawnHelper;
  /** Arguments for the helper command (tests: the fake helper script). Default `["serve"]`. */
  helperArgs?: readonly string[];
  /** How long a started helper may take to answer (tests: the fake helper starts slowly). */
  helperHelloTimeoutMs?: number;
  now?: () => number;
}

/**
 * This machine as the agent's hands: a login shell, the agent's own Chrome profile and (on macOS)
 * the desktop. Browser, computer and app controllers are created on first use; Chrome itself
 * launches only when a task opens its first tab, the computer helper on its first request.
 */
export class LocalExecutionProvider implements ExecutionProvider {
  readonly id = "local";
  readonly capabilities: ExecutionCapabilities;
  readonly shell: LocalShellExecutor;
  private readonly config: LocalExecutionConfig;
  private readonly deps: LocalProviderDeps;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly runner: CommandRunner;
  private readonly now: () => number;
  private readonly resolvedBrowser: ResolvedBrowser | undefined;
  private browserController: LocalBrowserController | undefined;
  private computerController: ComputerController | undefined;
  private appController: HelperAppController | undefined;
  private drawingRenderer: ChromiumDrawingRenderer | undefined;
  private hostLookup: { promise: Promise<ComputerHostApp | undefined>; at: number } | undefined;
  private disposed = false;

  constructor(config: LocalExecutionConfig, deps: LocalProviderDeps = {}) {
    this.config = config;
    this.deps = deps;
    this.logger = deps.logger ?? silentLogger;
    this.platform = deps.platform ?? process.platform;
    this.runner = deps.runner ?? execFileRunner;
    this.now = deps.now ?? Date.now;
    this.resolvedBrowser = (deps.resolveBrowser ?? resolveBrowserExecutable)(config.browser);
    this.shell = new LocalShellExecutor({ logger: this.logger.child({ component: "shell" }) });
    this.capabilities = {
      shell: true,
      browser: this.resolvedBrowser !== undefined,
      computer: this.platform === "darwin" && config.computer?.enabled !== false,
    };
  }

  /** Where Chrome keeps the agent's cookies and logins. */
  get browserProfileDir(): string {
    return join(this.config.home, "browser-profile");
  }

  get browserExecutable(): ResolvedBrowser | undefined {
    return this.resolvedBrowser;
  }

  /** The computer helper this provider uses, if one was configured. */
  get computerHelper(): string | undefined {
    return this.capabilities.computer ? this.config.computer?.helper : undefined;
  }

  get browser(): BrowserController | undefined {
    if (!this.resolvedBrowser || this.disposed) return undefined;
    this.browserController ??= new LocalBrowserController({
      profileDir: this.browserProfileDir,
      browser: this.resolvedBrowser,
      ...(this.config.browser?.headless === undefined
        ? {}
        : { headless: this.config.browser.headless }),
      logger: this.logger,
    });
    return this.browserController;
  }

  get computer(): ComputerController | undefined {
    if (!this.capabilities.computer || this.disposed) return undefined;
    this.computerController ??= createComputerController({
      platform: this.platform,
      logger: this.logger,
      runner: this.runner,
      hostName: async () => (await this.hostApp())?.name,
    });
    return this.computerController;
  }

  /** Renders drawings with the agent browser's executable, in a headless instance of its own. */
  get drawings(): DrawingRenderer | undefined {
    const pageDir = this.config.drawingRenderer;
    if (!this.resolvedBrowser || !pageDir || this.disposed) return undefined;
    this.drawingRenderer ??= new ChromiumDrawingRenderer({
      pageDir,
      cacheDir: join(this.config.home, "cache", "drawings"),
      executablePath: this.resolvedBrowser.executablePath,
      logger: this.logger.child({ component: "drawings" }),
    });
    return this.drawingRenderer;
  }

  get apps(): AppController | undefined {
    const helper = this.computerHelper;
    if (!helper || this.disposed) return undefined;
    this.appController ??= new HelperAppController({
      client: new HelperClient({
        command: helper,
        ...(this.deps.helperArgs ? { args: this.deps.helperArgs } : {}),
        ...(this.deps.spawnHelper ? { spawn: this.deps.spawnHelper } : {}),
        ...(this.deps.helperHelloTimeoutMs !== undefined
          ? { helloTimeoutMs: this.deps.helperHelloTimeoutMs }
          : {}),
        logger: this.logger,
      }),
      hostApp: () => this.hostApp(),
      logger: this.logger,
    });
    return this.appController.available ? this.appController : undefined;
  }

  async computerAccess(): Promise<ComputerAccess | undefined> {
    if (!this.capabilities.computer || this.disposed) return undefined;
    const apps = this.apps;
    const [permissions, hostApp] = await Promise.all([this.permissions(apps), this.hostApp()]);
    return {
      ...permissions,
      appControl: apps?.available === true,
      ...(hostApp ? { hostApp } : {}),
    };
  }

  prepareWorkspace(key: string): Promise<Workspace> {
    return prepareLocalWorkspace(this.config.home, key);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([
      this.browserController?.dispose(),
      this.appController?.dispose(),
      this.drawingRenderer?.dispose(),
      this.shell.dispose(),
    ]);
  }

  /** From the helper when there is one (it holds the same grants), else from a JXA probe. */
  private async permissions(apps: AppController | undefined): Promise<ComputerPermissions> {
    if (apps) {
      try {
        return await apps.permissions();
      } catch (error) {
        this.logger.debug("helper permission check failed", { error: String(error) });
      }
    }
    try {
      return (await this.computer?.permissions?.()) ?? none();
    } catch (error) {
      this.logger.debug("permission check failed", { error: String(error) });
      return none();
    }
  }

  private hostApp(): Promise<ComputerHostApp | undefined> {
    const cached = this.hostLookup;
    if (cached && (cached.at === 0 || this.now() - cached.at < HOST_APP_RETRY_MS)) {
      return cached.promise;
    }
    const lookup = { promise: Promise.resolve<ComputerHostApp | undefined>(undefined), at: 0 };
    lookup.promise = findHostApp(this.runner).then(
      (host) => {
        if (!host) lookup.at = this.now();
        return host;
      },
      (error: unknown) => {
        lookup.at = this.now();
        this.logger.debug("host app lookup failed", { error: String(error) });
        return undefined;
      },
    );
    this.hostLookup = lookup;
    return lookup.promise;
  }
}

function none(): ComputerPermissions {
  return { accessibility: false, screenRecording: false };
}
