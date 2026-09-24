import { join } from "node:path";
import { type Logger, silentLogger } from "@ddl/core";
import type {
  BrowserController,
  ComputerController,
  ExecutionCapabilities,
  ExecutionConfig,
  ExecutionProvider,
  Workspace,
} from "../types";
import { LocalBrowserController } from "./browser";
import { type ResolvedBrowser, resolveBrowserExecutable } from "./browser-executable";
import { createComputerController } from "./computer-macos";
import { LocalShellExecutor } from "./shell";
import { prepareLocalWorkspace } from "./workspace";

export type LocalExecutionConfig = Extract<ExecutionConfig, { kind: "local" }>;

export interface LocalProviderDeps {
  logger?: Logger;
  platform?: NodeJS.Platform;
  /** Override browser discovery (tests). */
  resolveBrowser?: (config: LocalExecutionConfig["browser"]) => ResolvedBrowser | undefined;
}

/**
 * This machine as the agent's hands: a login shell, the agent's own Chrome profile and (on macOS)
 * the desktop. Browser and computer controllers are created on first use; Chrome itself launches
 * only when a task opens its first tab.
 */
export class LocalExecutionProvider implements ExecutionProvider {
  readonly id = "local";
  readonly capabilities: ExecutionCapabilities;
  readonly shell: LocalShellExecutor;
  private readonly config: LocalExecutionConfig;
  private readonly logger: Logger;
  private readonly platform: NodeJS.Platform;
  private readonly resolvedBrowser: ResolvedBrowser | undefined;
  private browserController: LocalBrowserController | undefined;
  private computerController: ComputerController | undefined;
  private disposed = false;

  constructor(config: LocalExecutionConfig, deps: LocalProviderDeps = {}) {
    this.config = config;
    this.logger = deps.logger ?? silentLogger;
    this.platform = deps.platform ?? process.platform;
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
    });
    return this.computerController;
  }

  prepareWorkspace(key: string): Promise<Workspace> {
    return prepareLocalWorkspace(this.config.home, key);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([this.browserController?.dispose(), this.shell.dispose()]);
  }
}
