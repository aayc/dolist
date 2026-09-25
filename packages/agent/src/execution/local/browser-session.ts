import type { Logger, Unsubscribe } from "@ddl/core";
import type { BrowserContext, Dialog, Locator, Page } from "playwright-core";
import { ExecutionError } from "../errors";
import type {
  BrowserSession,
  BrowserSnapshot,
  BrowserTarget,
  FrameListener,
  Screenshot,
} from "../types";
import { type FrameAction, FrameHub } from "../util/frame-hub";
import { jpegSize } from "../util/jpeg";
import { Mutex } from "../util/mutex";
import {
  actionFailure,
  cleanPlaywrightMessage,
  isDownloadStart,
  isNavigationRace,
} from "./browser-errors";
import { normalizeBrowserKey } from "./browser-keys";
import { Screencast, type ScreencastFrame, type ScreencastOptions } from "./browser-screencast";
import { runAndSettle, type SettleOptions } from "./browser-settle";
import { fieldRefsWithValues, formatSnapshot, maskFieldValues } from "./browser-snapshot";
import { elementCenter, isSensitiveField, resolveTarget } from "./browser-targets";
import {
  capText,
  collapseWhitespace,
  DEFAULT_EXTRACT_MAX_CHARS,
  readablePageText,
} from "./browser-text";
import { normalizeNavigationUrl } from "./browser-url";

export interface BrowserSessionOptions {
  viewport: { width: number; height: number };
  snapshotMaxChars: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  settle: SettleOptions;
  screencast: ScreencastOptions;
  /** The screencast pauses after this long without actions or new viewers. */
  screencastIdleMs: number;
}

const SNAPSHOT_TIMEOUT_MS = 10_000;
const FIELD_CHECK_TIMEOUT_MS = 1_000;
/** More value-bearing fields than this are masked without checking (fail closed). */
const MAX_FIELD_CHECKS = 50;
const MAX_FULL_PAGE_HEIGHT = 4_000;
const SCREENSHOT_QUALITY = 70;
const HIDDEN_TEXT = "••••••";

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Runs in the page: puts the caret at the end of an input/textarea so typing appends. */
const moveCaretToEnd = (element: Element): void => {
  const field = element as HTMLInputElement;
  if (typeof field.value !== "string" || typeof field.setSelectionRange !== "function") return;
  try {
    field.setSelectionRange(field.value.length, field.value.length);
  } catch {
    // Some input types (email, number) don't support selection.
  }
};

/** Runs in the page: whether the focused element (through shadow roots) takes line breaks. */
const focusTakesLineBreaks = (element: Element): boolean => {
  let focused = element.ownerDocument.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  return (
    focused instanceof HTMLTextAreaElement ||
    (focused instanceof HTMLElement && focused.isContentEditable)
  );
};

/** Runs in the page: scrollable document size. */
const documentSize = (): { width: number; height: number } => ({
  width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
  height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
});

/**
 * One task's tab (plus any popups it opened) in the shared agent browser. Actions are serialized;
 * each returns a fresh snapshot once the page has settled.
 */
export class LocalBrowserSession implements BrowserSession {
  readonly key: string;
  private readonly context: BrowserContext;
  private readonly options: BrowserSessionOptions;
  private readonly logger: Logger;
  private readonly onClosed: (session: LocalBrowserSession) => void;
  private readonly mutex = new Mutex();
  private readonly screencastQueue = new Mutex();
  private readonly frames: FrameHub;
  private readonly closingByUs = new WeakSet<Page>();
  /** Tab stack: the last page is the active one. */
  private pages: Page[] = [];
  private notes: string[] = [];
  private title = "";
  private screencast: Screencast | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private idle = false;
  private closed = false;

  private constructor(
    context: BrowserContext,
    key: string,
    options: BrowserSessionOptions,
    logger: Logger,
    onClosed: (session: LocalBrowserSession) => void,
  ) {
    this.context = context;
    this.key = key;
    this.options = options;
    this.logger = logger;
    this.onClosed = onClosed;
    this.frames = new FrameHub({
      onFirst: () => this.syncScreencast(),
      onLast: () => this.syncScreencast(),
      logger,
    });
  }

  /** Opens the session on `page` (e.g. the context's initial blank tab) or a new tab. */
  static async open(params: {
    context: BrowserContext;
    key: string;
    options: BrowserSessionOptions;
    logger: Logger;
    onClosed: (session: LocalBrowserSession) => void;
    page?: Page;
  }): Promise<LocalBrowserSession> {
    const session = new LocalBrowserSession(
      params.context,
      params.key,
      params.options,
      params.logger,
      params.onClosed,
    );
    session.attach(params.page ?? (await params.context.newPage()));
    session.touch();
    return session;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** True while an action is running or queued. */
  get busy(): boolean {
    return this.mutex.busy;
  }

  // ── BrowserSession ────────────────────────────────────────────────────────

  async navigate(url: string): Promise<BrowserSnapshot> {
    const target = normalizeNavigationUrl(url);
    return this.run(async (page) => {
      try {
        const response = await runAndSettle(
          page,
          () =>
            page.goto(target.href, {
              waitUntil: "domcontentloaded",
              timeout: this.options.navigationTimeoutMs,
            }),
          this.options.settle,
        );
        const status = response?.status() ?? 0;
        if (status >= 400) {
          this.note(`The server answered HTTP ${status} ${response?.statusText() ?? ""}`.trim());
        }
      } catch (error) {
        if (!isDownloadStart(error)) {
          throw new ExecutionError(
            `Could not open ${target.href}: ${cleanPlaywrightMessage(error)}`,
            { cause: error },
          );
        }
        this.note(`Opening ${target.href} started a download instead of showing a page.`);
      }
      const current = await this.activePage();
      await this.emitActionFrame(current, { kind: "navigate", text: target.href });
      return this.capture(current);
    });
  }

  snapshot(): Promise<BrowserSnapshot> {
    return this.run((page) => this.capture(page));
  }

  click(target: BrowserTarget): Promise<BrowserSnapshot> {
    return this.run(async (page) => {
      const locator = await resolveTarget(page, target);
      const center = await this.prepare(locator);
      await runAndSettle(
        page,
        () => locator.click({ timeout: this.options.actionTimeoutMs }),
        this.options.settle,
      ).catch((error: unknown) => {
        throw actionFailure("click", error, this.options.actionTimeoutMs);
      });
      const current = await this.afterAction(page);
      await this.emitActionFrame(current, { kind: "click", ...center });
      return this.capture(current);
    });
  }

  type(
    target: BrowserTarget,
    text: string,
    options: { submit?: boolean; clear?: boolean } = {},
  ): Promise<BrowserSnapshot> {
    return this.run(async (page) => {
      const locator = await resolveTarget(page, target);
      const center = await this.prepare(locator);
      const sensitive = await locator
        .evaluate(isSensitiveField, undefined, { timeout: FIELD_CHECK_TIMEOUT_MS })
        .catch(() => true);
      const timeout = this.options.actionTimeoutMs;
      await runAndSettle(
        page,
        async () => {
          if (options.clear === false) {
            await locator.focus({ timeout });
            await locator.evaluate(moveCaretToEnd).catch(() => {});
            await this.typeKeys(page, locator, text);
          } else {
            await this.fill(page, locator, text);
          }
          if (options.submit) await page.keyboard.press("Enter");
        },
        this.options.settle,
      ).catch((error: unknown) => {
        throw actionFailure("type into", error, timeout);
      });
      const current = await this.afterAction(page);
      const shown = sensitive ? HIDDEN_TEXT : clip(text, 80);
      await this.emitActionFrame(current, { kind: "type", text: shown, ...center });
      return this.capture(current);
    });
  }

  selectOption(target: BrowserTarget, values: string[]): Promise<BrowserSnapshot> {
    return this.run(async (page) => {
      const locator = await resolveTarget(page, target);
      const center = await this.prepare(locator);
      await runAndSettle(
        page,
        () => locator.selectOption(values, { timeout: this.options.actionTimeoutMs }),
        this.options.settle,
      ).catch((error: unknown) => {
        throw actionFailure("select an option in", error, this.options.actionTimeoutMs);
      });
      const current = await this.afterAction(page);
      await this.emitActionFrame(current, { kind: "select", text: values.join(", "), ...center });
      return this.capture(current);
    });
  }

  press(key: string): Promise<BrowserSnapshot> {
    return this.run(async (page) => {
      const normalized = normalizeBrowserKey(key);
      await runAndSettle(page, () => page.keyboard.press(normalized), this.options.settle).catch(
        (error: unknown) => {
          throw new ExecutionError(
            `Could not press ${normalized}: ${cleanPlaywrightMessage(error)}`,
            {
              cause: error,
            },
          );
        },
      );
      const current = await this.afterAction(page);
      await this.emitActionFrame(current, { kind: "key", text: normalized });
      return this.capture(current);
    });
  }

  scroll(direction: "up" | "down", pixels?: number): Promise<BrowserSnapshot> {
    return this.run(async (page) => {
      const { width, height } = this.options.viewport;
      const requested = pixels !== undefined && Number.isFinite(pixels) ? pixels : height * 0.8;
      const amount = Math.round(Math.min(Math.max(requested, 1), 20_000));
      await page.mouse.move(width / 2, height / 2);
      await runAndSettle(
        page,
        () => page.mouse.wheel(0, direction === "down" ? amount : -amount),
        this.options.settle,
      );
      await this.emitActionFrame(page, { kind: "scroll", text: `${direction} ${amount}px` });
      return this.capture(page);
    });
  }

  back(): Promise<BrowserSnapshot> {
    return this.run(async (page) => {
      const before = page.url();
      const response = await runAndSettle(
        page,
        () =>
          page.goBack({ waitUntil: "domcontentloaded", timeout: this.options.navigationTimeoutMs }),
        this.options.settle,
      ).catch((error: unknown) => {
        throw new ExecutionError(`Could not go back: ${cleanPlaywrightMessage(error)}`, {
          cause: error,
        });
      });
      let current = page;
      if (response === null && page.url() === before) {
        if (this.pages.length > 1) {
          this.closingByUs.add(page);
          await page.close({ runBeforeUnload: false }).catch(() => {});
          current = await this.activePage();
          this.note("This tab had no earlier page, so it was closed; back on the previous tab.");
        } else {
          this.note("There is no earlier page in this tab's history.");
        }
      }
      await this.emitActionFrame(current, { kind: "back" });
      return this.capture(current);
    });
  }

  screenshot(options: { fullPage?: boolean } = {}): Promise<Screenshot> {
    return this.run(async (page) => {
      const { viewport } = this.options;
      let clipRect: { x: number; y: number; width: number; height: number } | undefined;
      if (options.fullPage) {
        const size = await this.evaluate(page, documentSize);
        clipRect = {
          x: 0,
          y: 0,
          width: Math.max(1, Math.min(size.width, viewport.width)),
          height: Math.max(1, Math.min(size.height, MAX_FULL_PAGE_HEIGHT)),
        };
      }
      const buffer = await page.screenshot({
        type: "jpeg",
        quality: SCREENSHOT_QUALITY,
        fullPage: Boolean(options.fullPage),
        timeout: 15_000,
        ...(clipRect ? { clip: clipRect } : {}),
      });
      const size = jpegSize(buffer) ?? viewport;
      const data = buffer.toString("base64");
      if (!options.fullPage) this.emitFrame(page, { data, ...size }, { kind: "screenshot" });
      return { data, mimeType: "image/jpeg", width: size.width, height: size.height };
    });
  }

  extractText(options: { maxChars?: number } = {}): Promise<string> {
    return this.run(async (page) => {
      const raw = await this.evaluate(page, readablePageText);
      return capText(collapseWhitespace(raw), options.maxChars ?? DEFAULT_EXTRACT_MAX_CHARS);
    });
  }

  onFrame(listener: FrameListener): Unsubscribe {
    if (this.closed) return () => {};
    const unsubscribe = this.frames.subscribe(listener);
    // A new viewer gets the current page right away and counts as activity for the screencast.
    this.touch();
    const page = this.pages.at(-1);
    if (page) void this.emitActionFrame(page);
    return unsubscribe;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.frames.clear();
    this.syncScreencast();
    const pages = this.pages;
    this.pages = [];
    await Promise.allSettled(
      pages.map((page) => {
        this.closingByUs.add(page);
        return page.close({ runBeforeUnload: false });
      }),
    );
    await this.screencastQueue.run(async () => {});
    this.onClosed(this);
  }

  /** The browser went away underneath us (crash, window closed): drop state without closing pages. */
  markContextClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.frames.clear();
    this.screencast = undefined;
    this.pages = [];
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private run<T>(action: (page: Page) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      if (this.closed) throw new ExecutionError(`Browser session ${this.key} is closed.`);
      this.touch();
      return action(await this.activePage());
    });
  }

  private async activePage(): Promise<Page> {
    const page = this.pages.at(-1);
    if (page && !page.isClosed()) return page;
    const fresh = await this.context.newPage();
    this.attach(fresh);
    return fresh;
  }

  /** Scrolls the element into view and returns its center for the frame overlay. */
  private async prepare(locator: Locator): Promise<{ x: number; y: number } | undefined> {
    await locator.scrollIntoViewIfNeeded({ timeout: this.options.actionTimeoutMs }).catch(() => {});
    return elementCenter(locator);
  }

  private async fill(page: Page, locator: Locator, text: string): Promise<void> {
    try {
      await locator.fill(text, { timeout: this.options.actionTimeoutMs });
    } catch (error) {
      if (!/not an <input>|not editable|does not have a role allowing/i.test(String(error))) {
        throw error;
      }
      // Custom widgets that aren't fillable still take keyboard input once focused.
      await locator.click({ timeout: this.options.actionTimeoutMs });
      await this.typeKeys(page, locator, text);
    }
  }

  /**
   * Keyboard typing that never presses Enter, so only `submit` can submit: a line break becomes
   * Shift+Enter (a new line without sending, in chat apps and editors) where the focused field
   * takes line breaks, and is dropped elsewhere, the way `fill` drops it from single-line inputs.
   */
  private async typeKeys(page: Page, locator: Locator, text: string): Promise<void> {
    const lines = text.split(/\r\n?|\n/);
    if (lines.length === 1) return page.keyboard.type(text);
    const multiline = await locator
      .evaluate(focusTakesLineBreaks, undefined, { timeout: FIELD_CHECK_TIMEOUT_MS })
      .catch(() => false);
    if (!multiline) return page.keyboard.type(lines.join(""));
    for (const [index, line] of lines.entries()) {
      if (index > 0) await page.keyboard.press("Shift+Enter");
      if (line) await page.keyboard.type(line);
    }
  }

  /** A click may have opened a popup that is now active; give it a moment to load. */
  private async afterAction(previous: Page): Promise<Page> {
    const current = await this.activePage();
    if (current !== previous) {
      await current
        .waitForLoadState("domcontentloaded", { timeout: this.options.settle.maxWaitMs ?? 3_000 })
        .catch(() => {});
    }
    return current;
  }

  private async capture(page: Page): Promise<BrowserSnapshot> {
    const raw = await this.ariaSnapshot(page);
    const sensitive = await this.sensitiveRefs(page, fieldRefsWithValues(raw));
    const snapshot = formatSnapshot(maskFieldValues(raw, sensitive), this.options.snapshotMaxChars);
    const title = await page.title().catch(() => "");
    this.title = title;
    const notes = this.notes;
    this.notes = [];
    return { url: page.url(), title, snapshot, ...(notes.length > 0 ? { notes } : {}) };
  }

  private ariaSnapshot(page: Page): Promise<string> {
    return this.retryAfterNavigation(page, () =>
      page.ariaSnapshot({ mode: "ai", timeout: SNAPSHOT_TIMEOUT_MS }),
    );
  }

  private evaluate<T>(page: Page, fn: () => T): Promise<T> {
    return this.retryAfterNavigation(page, () => page.evaluate(fn));
  }

  /** Reads race with navigations the last action started; one retry after the new document loads. */
  private async retryAfterNavigation<T>(page: Page, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (!isNavigationRace(error)) throw error;
      await page
        .waitForLoadState("domcontentloaded", { timeout: SNAPSHOT_TIMEOUT_MS })
        .catch(() => {});
      return read();
    }
  }

  /** Refs whose values must be masked; anything that can't be checked is masked. */
  private async sensitiveRefs(page: Page, refs: string[]): Promise<Set<string>> {
    const sensitive = new Set<string>();
    await Promise.all(
      refs.map(async (ref, index) => {
        const masked =
          index >= MAX_FIELD_CHECKS ||
          (await page
            .locator(`aria-ref=${ref}`)
            .evaluate(isSensitiveField, undefined, { timeout: FIELD_CHECK_TIMEOUT_MS })
            .catch(() => true));
        if (masked) sensitive.add(ref);
      }),
    );
    return sensitive;
  }

  private attach(page: Page): void {
    this.pages.push(page);
    page.on("dialog", (dialog) => this.onDialog(dialog));
    page.on("popup", (popup) => this.onPopup(popup));
    page.on("close", () => this.onPageClosed(page));
    page.on("crash", () => {
      this.note("The tab crashed; a fresh tab will be used for the next action.");
      page.close().catch(() => {});
    });
    page.on("download", (download) => {
      this.note(`A download started (${download.suggestedFilename()}); downloads are not kept.`);
    });
    // Listening intercepts the native file picker, so nothing on disk can be selected.
    page.on("filechooser", () => {
      this.note("The page asked for a file upload; uploads are not supported, nothing was chosen.");
    });
    page.on("load", () => this.refreshTitle(page));
    this.syncScreencast();
  }

  private onDialog(dialog: Dialog): void {
    const type = dialog.type();
    const message = clip(dialog.message().replace(/\s+/g, " ").trim(), 200);
    if (type === "beforeunload") {
      dialog.accept().catch(() => {});
      return;
    }
    dialog.dismiss().catch(() => {});
    const quoted = message ? ` ("${message}")` : "";
    const outcome = type === "alert" ? "closed" : "dismissed (Cancel)";
    this.note(`The page showed a ${type} dialog${quoted}; it was ${outcome}.`);
  }

  private onPopup(popup: Page): void {
    if (this.closed) {
      popup.close().catch(() => {});
      return;
    }
    this.attach(popup);
    this.note(
      "The page opened a new tab, which is now active. browser_back returns to the previous tab.",
    );
  }

  private onPageClosed(page: Page): void {
    const wasActive = this.pages.at(-1) === page;
    this.pages = this.pages.filter((p) => p !== page);
    if (!this.closed && wasActive && this.pages.length > 0 && !this.closingByUs.has(page)) {
      this.note("The page closed its tab; back on the previous tab.");
    }
    this.syncScreencast();
  }

  private refreshTitle(page: Page): void {
    page
      .title()
      .then((title) => {
        if (this.pages.at(-1) === page) this.title = title;
      })
      .catch(() => {});
  }

  private note(text: string): void {
    this.notes.push(text);
    if (this.notes.length > 20) this.notes.shift();
  }

  private touch(): void {
    const wasIdle = this.idle;
    this.idle = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.idle = true;
      this.syncScreencast();
    }, this.options.screencastIdleMs);
    this.idleTimer.unref?.();
    if (wasIdle) this.syncScreencast();
  }

  /** Converges the screencast onto the active page while someone is watching and we're not idle. */
  private syncScreencast(): void {
    void this.screencastQueue.run(async () => {
      const active = this.pages.at(-1);
      const target =
        !this.closed && !this.idle && this.frames.size > 0 && active && !active.isClosed()
          ? active
          : undefined;
      if (this.screencast?.page === target) return;
      const previous = this.screencast;
      this.screencast = undefined;
      await previous?.stop();
      if (!target) return;
      try {
        this.screencast = await Screencast.start(
          target,
          (frame) => this.emitFrame(target, frame),
          this.options.screencast,
          this.logger,
        );
      } catch (error) {
        this.logger.debug("screencast unavailable", { error: String(error) });
      }
    });
  }

  private emitFrame(page: Page, image: ScreencastFrame, action?: FrameAction): void {
    if (this.closed || this.frames.size === 0) return;
    this.frames.emit({
      mimeType: "image/jpeg",
      data: image.data,
      width: image.width,
      height: image.height,
      url: page.url(),
      title: this.title,
      ts: Date.now(),
      ...(action ? { action } : {}),
    });
  }

  /** One frame after each action so the UI updates even when the screencast is quiet. */
  private async emitActionFrame(page: Page, action?: FrameAction): Promise<void> {
    if (this.closed || this.frames.size === 0 || page.isClosed()) return;
    try {
      const buffer = await page.screenshot({
        type: "jpeg",
        quality: this.options.screencast.quality,
        timeout: 5_000,
      });
      const size = jpegSize(buffer) ?? this.options.viewport;
      this.emitFrame(page, { data: buffer.toString("base64"), ...size }, action);
    } catch (error) {
      this.logger.debug("action frame capture failed", { error: String(error) });
    }
  }
}
