import { chmod, mkdir } from "node:fs/promises";
import { type Logger, silentLogger } from "@ddl/core";
import type { BrowserContext, Page } from "playwright-core";
import { BrowserUnavailableError, ExecutionError } from "../errors";
import type { BrowserController, BrowserSession } from "../types";
import { cleanPlaywrightMessage } from "./browser-errors";
import type { ResolvedBrowser } from "./browser-executable";
import { DEFAULT_SCREENCAST, type ScreencastOptions } from "./browser-screencast";
import { type BrowserSessionOptions, LocalBrowserSession } from "./browser-session";
import { DEFAULT_SNAPSHOT_MAX_CHARS } from "./browser-snapshot";

/** Tabs kept open at once; the least recently used idle session is closed beyond this. */
const MAX_SESSIONS = 8;

export interface LocalBrowserOptions {
  /** Persistent profile directory (logins survive across tasks). */
  profileDir: string;
  browser: ResolvedBrowser;
  /** Default true. */
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Chromium's OS sandbox. Default on, except Linux where CI containers usually can't provide it. */
  sandbox?: boolean;
  snapshotMaxChars?: number;
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
  /** How long Chrome may take to start. Default 30 s. */
  launchTimeoutMs?: number;
  settleMaxMs?: number;
  screencast?: Partial<ScreencastOptions>;
  screencastIdleMs?: number;
  logger?: Logger;
}

/**
 * One persistent Chrome context (the agent's own profile, separate from the user's browser) with
 * one session — a tab — per thread. Chrome launches lazily on the first session.
 */
export class LocalBrowserController implements BrowserController {
  private readonly options: LocalBrowserOptions;
  private readonly sessionOptions: BrowserSessionOptions;
  private readonly logger: Logger;
  private readonly sessions = new Map<string, LocalBrowserSession>();
  private readonly opening = new Map<string, Promise<LocalBrowserSession>>();
  private contextPromise: Promise<BrowserContext> | undefined;
  private initialPageClaimed = false;
  private disposed = false;

  constructor(options: LocalBrowserOptions) {
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child({ component: "browser" });
    const viewport = options.viewport ?? { width: 1280, height: 800 };
    this.sessionOptions = {
      viewport,
      snapshotMaxChars: options.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
      actionTimeoutMs: options.actionTimeoutMs ?? 8_000,
      navigationTimeoutMs: options.navigationTimeoutMs ?? 30_000,
      settle: { maxWaitMs: options.settleMaxMs ?? 3_000, quietMs: 250 },
      screencast: {
        ...DEFAULT_SCREENCAST,
        maxWidth: viewport.width,
        maxHeight: viewport.height,
        ...options.screencast,
      },
      screencastIdleMs: options.screencastIdleMs ?? 60_000,
    };
  }

  async session(key: string): Promise<BrowserSession> {
    if (this.disposed) throw new ExecutionError("The browser controller has been disposed.");
    const existing = this.sessions.get(key);
    if (existing && !existing.isClosed) {
      // Map order doubles as the LRU order.
      this.sessions.delete(key);
      this.sessions.set(key, existing);
      return existing;
    }
    let pending = this.opening.get(key);
    if (!pending) {
      pending = this.openSession(key).finally(() => this.opening.delete(key));
      this.opening.set(key, pending);
    }
    return pending;
  }

  has(key: string): boolean {
    const session = this.sessions.get(key);
    return session !== undefined && !session.isClosed;
  }

  async close(key: string): Promise<void> {
    const session = this.sessions.get(key) ?? (await this.opening.get(key)?.catch(() => undefined));
    await session?.close();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    const context = await this.contextPromise?.catch(() => undefined);
    this.contextPromise = undefined;
    await context?.close().catch((error: unknown) => {
      this.logger.warn("closing the browser failed", { error: String(error) });
    });
  }

  private async openSession(key: string): Promise<LocalBrowserSession> {
    const context = await this.context();
    if (this.disposed) throw new ExecutionError("The browser controller has been disposed.");
    this.evictIdleSessions();
    const session = await LocalBrowserSession.open({
      context,
      key,
      options: this.sessionOptions,
      logger: this.logger.child({ session: key }),
      onClosed: (closed) => {
        if (this.sessions.get(key) === closed) this.sessions.delete(key);
      },
      page: this.claimInitialPage(context),
    });
    this.sessions.set(key, session);
    this.logger.debug("browser session opened", { session: key, open: this.sessions.size });
    return session;
  }

  /** The persistent context starts with one blank tab; the first session uses it. */
  private claimInitialPage(context: BrowserContext): Page | undefined {
    if (this.initialPageClaimed) return undefined;
    this.initialPageClaimed = true;
    const [first] = context.pages();
    return first && !first.isClosed() && first.url() === "about:blank" ? first : undefined;
  }

  private evictIdleSessions(): void {
    for (const [key, session] of this.sessions) {
      if (this.sessions.size < MAX_SESSIONS) return;
      if (session.busy) continue;
      this.sessions.delete(key);
      this.logger.debug("closing least recently used browser session", { session: key });
      session.close().catch((error: unknown) => {
        this.logger.warn("closing evicted session failed", { error: String(error) });
      });
    }
  }

  private context(): Promise<BrowserContext> {
    this.contextPromise ??= this.launch().catch((error: unknown) => {
      this.contextPromise = undefined;
      throw error;
    });
    return this.contextPromise;
  }

  private async launch(): Promise<BrowserContext> {
    const { profileDir, browser } = this.options;
    const headless = this.options.headless ?? true;
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await chmod(profileDir, 0o700);
    const startedAt = performance.now();
    let context: BrowserContext;
    try {
      // Loaded on first launch: Playwright costs ~150 ms of daemon startup otherwise.
      const { chromium } = await import("playwright-core");
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: browser.executablePath,
        headless,
        viewport: this.sessionOptions.viewport,
        chromiumSandbox: this.options.sandbox ?? process.platform !== "linux",
        // Keep Chrome's popup blocker: pages may only open tabs in response to a click.
        ignoreDefaultArgs: ["--disable-popup-blocking"],
        args: ["--hide-crash-restore-bubble"],
        // The daemon owns process signals and disposes the provider on shutdown.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        timeout: this.options.launchTimeoutMs ?? 30_000,
      });
    } catch (error) {
      throw new BrowserUnavailableError(launchFailureMessage(error, profileDir), { cause: error });
    }
    context.setDefaultTimeout(this.sessionOptions.actionTimeoutMs);
    context.setDefaultNavigationTimeout(this.sessionOptions.navigationTimeoutMs);
    context.on("close", () => this.onContextClosed(context));
    this.logger.info("browser launched", {
      source: browser.source,
      headless,
      ms: Math.round(performance.now() - startedAt),
    });
    return context;
  }

  private onContextClosed(context: BrowserContext): void {
    if (this.disposed) return;
    void this.contextPromise?.then((current) => {
      if (current !== context) return;
      this.logger.warn("browser closed unexpectedly; it will relaunch on next use");
      this.contextPromise = undefined;
      this.initialPageClaimed = false;
      for (const session of this.sessions.values()) session.markContextClosed();
      this.sessions.clear();
    });
  }
}

function launchFailureMessage(error: unknown, profileDir: string): string {
  const message = cleanPlaywrightMessage(error);
  if (/ProcessSingleton|already running|profile.*in use|SingletonLock/i.test(String(error))) {
    return `The agent browser profile (${profileDir}) is in use by another Chrome process. Stop the other daemon or close that browser, then retry.`;
  }
  return `Could not launch the browser: ${message}`;
}
