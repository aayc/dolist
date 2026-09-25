/**
 * Renders drawings to PNG in headless Chromium, on a page built with Excalidraw's own export
 * (`src/drawings/render-page`, built by `scripts/build-drawing-renderer.mjs`), so the agent sees a
 * drawing the way the editor draws it.
 *
 * It uses a browser of its own rather than the agent's: that one is a persistent profile with the
 * user's logins, may run headed, and lives until the daemon stops. This one has no profile and no
 * network (the page's files are served by request interception; every other request is aborted),
 * launches on the first render through playwright-core (never at daemon start) and closes after a
 * minute without renders. Renders are cached on disk by a hash of the page's build and the scene.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { type DrawingElement, type DrawingScene, type Logger, silentLogger } from "@ddl/core";
import { RenderCache } from "../../drawings/render-cache";
import type { RenderPageInput, RenderPageOutput } from "../../drawings/render-page/protocol";
import {
  DRAWING_IMAGE_MAX_SIZE,
  DrawingRenderError,
  type DrawingRenderer,
  type RenderDrawingOptions,
  type RenderedDrawing,
} from "../../drawings/renderer";
import { raceAbort } from "../util/abort";
import { Mutex } from "../util/mutex";

/** The page's origin: never resolved, every request to it is answered from the page directory. */
export const RENDER_ORIGIN = "https://drawings.invalid";
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SCALE = 2;
const PADDING = 16;
const BACKGROUND = "#ffffff";
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'";
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8",
};

/** The open render page: one browser, one tab. */
export interface RenderPage {
  render(input: RenderPageInput): Promise<RenderPageOutput>;
  close(): Promise<void>;
  /** The page or its browser went away (a crash): the next render opens a new one. */
  readonly closed: boolean;
}

export interface OpenRenderPageOptions {
  pageDir: string;
  executablePath: string;
  sandbox: boolean;
  timeoutMs: number;
}

export interface ChromiumDrawingRendererOptions {
  /** The built render page (index.html, render.js, fonts/, version.json). */
  pageDir: string;
  /** Machine-local render cache, e.g. `$DDL_HOME/cache/drawings`. */
  cacheDir: string;
  /** The Chromium-based browser to run headless (the agent browser's executable). */
  executablePath: string;
  /** Chromium's OS sandbox. Default on, except Linux (CI containers usually can't provide it). */
  sandbox?: boolean;
  /** The browser closes after this long without renders. Default 60 s. */
  idleMs?: number;
  /** One render, launching the browser included. Default 30 s. */
  timeoutMs?: number;
  cacheMaxBytes?: number;
  logger?: Logger;
  /** Opens the page (tests: a fake). Default: headless Chromium through playwright-core. */
  openPage?: (options: OpenRenderPageOptions) => Promise<RenderPage>;
}

export class ChromiumDrawingRenderer implements DrawingRenderer {
  private readonly options: ChromiumDrawingRendererOptions;
  private readonly logger: Logger;
  private readonly cache: RenderCache;
  private readonly mutex = new Mutex();
  private page: Promise<RenderPage> | null = null;
  private build: Promise<string> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(options: ChromiumDrawingRendererOptions) {
    this.options = options;
    this.logger = options.logger ?? silentLogger;
    this.cache = new RenderCache({
      dir: options.cacheDir,
      ...(options.cacheMaxBytes !== undefined ? { maxBytes: options.cacheMaxBytes } : {}),
      logger: this.logger,
    });
  }

  async render(scene: DrawingScene, options: RenderDrawingOptions = {}): Promise<RenderedDrawing> {
    if (this.disposed) throw new DrawingRenderError("The drawing renderer has shut down.");
    const elements = scene.elements.filter((element) => element.isDeleted !== true);
    if (elements.length === 0) throw new DrawingRenderError("The drawing is empty.");
    const maxSize = Math.round(
      Math.min(Math.max(options.maxSize ?? DRAWING_IMAGE_MAX_SIZE, 64), 4_096),
    );
    const input: RenderPageInput = {
      elements,
      files: filesOf(scene, elements),
      maxSize,
      maxScale: MAX_SCALE,
      padding: PADDING,
      background: BACKGROUND,
    };
    const key = createHash("sha256")
      .update(await this.pageBuild())
      .update("\0")
      .update(JSON.stringify(input))
      .digest("hex");
    const cached = await this.cache.get(key).catch(() => null);
    const cachedSize = cached ? pngSize(cached) : undefined;
    if (cached && cachedSize) {
      return {
        data: cached.toString("base64"),
        mimeType: "image/png",
        ...cachedSize,
        cached: true,
      };
    }
    const startedAt = performance.now();
    const output = await raceAbort(
      this.mutex.run(() => this.renderOnPage(input)),
      options.signal,
    );
    const bytes = Buffer.from(output.data, "base64");
    const size = pngSize(bytes);
    if (!size) throw new DrawingRenderError("The renderer returned something other than a PNG.");
    if (size.width > maxSize + 1 || size.height > maxSize + 1) {
      throw new DrawingRenderError(
        `The render is ${size.width}×${size.height} px, over ${maxSize}.`,
      );
    }
    await this.cache.put(key, bytes).catch((error: unknown) => {
      this.logger.warn("Could not cache a drawing render", { error: errorText(error) });
    });
    this.logger.debug("drawing rendered", {
      ms: Math.round(performance.now() - startedAt),
      elements: elements.length,
      ...size,
    });
    return { data: output.data, mimeType: "image/png", ...size, cached: false };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    await this.mutex.run(() => this.closePage());
  }

  private async renderOnPage(input: RenderPageInput): Promise<RenderPageOutput> {
    if (this.disposed) throw new DrawingRenderError("The drawing renderer has shut down.");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DrawingRenderError("Rendering the drawing took too long.")),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([this.openPage().then((page) => page.render(input)), timeout]);
    } catch (error) {
      // A page that hung or crashed may be broken: the next render starts from a new browser.
      const page = await this.page?.catch(() => null);
      if (error instanceof DrawingRenderError || !page || page.closed) await this.closePage();
      throw error instanceof DrawingRenderError
        ? error
        : new DrawingRenderError(firstLine(errorText(error)));
    } finally {
      clearTimeout(timer);
      if (!this.disposed) this.scheduleIdle();
    }
  }

  private async openPage(): Promise<RenderPage> {
    const current = await this.page?.catch(() => null);
    if (current && !current.closed) return current;
    const startedAt = performance.now();
    const open = this.options.openPage ?? openChromiumPage;
    const opening = open({
      pageDir: this.options.pageDir,
      executablePath: this.options.executablePath,
      sandbox: this.options.sandbox ?? process.platform !== "linux",
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.page = opening;
    opening.then(
      () =>
        this.logger.info("drawing renderer started", {
          ms: Math.round(performance.now() - startedAt),
        }),
      () => {
        if (this.page === opening) this.page = null;
      },
    );
    return opening;
  }

  private async closePage(): Promise<void> {
    const opening = this.page;
    this.page = null;
    const page = await opening?.catch(() => null);
    if (!page) return;
    await page.close().catch((error: unknown) => {
      this.logger.debug("closing the drawing renderer failed", { error: errorText(error) });
    });
  }

  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.mutex.busy) return;
      void this.mutex.run(() => this.closePage());
    }, this.options.idleMs ?? DEFAULT_IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** Keys the render cache: a new page (another Excalidraw) renders again. */
  private pageBuild(): Promise<string> {
    this.build ??= readFile(join(this.options.pageDir, "version.json"), "utf8")
      .then((text) => String((JSON.parse(text) as { build?: unknown }).build ?? text))
      .catch(() => "unknown");
    return this.build;
  }
}

/** Headless Chromium on the render page, with no profile and every request answered locally. */
async function openChromiumPage(options: OpenRenderPageOptions): Promise<RenderPage> {
  // Loaded on first render: Playwright costs ~150 ms of daemon startup otherwise.
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: options.executablePath,
    headless: true,
    chromiumSandbox: options.sandbox,
    args: ["--hide-scrollbars", "--mute-audio"],
    // The daemon owns process signals and disposes the renderer on shutdown.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: options.timeoutMs,
  });
  let crashed = false;
  try {
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const pageDir = normalize(options.pageDir);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== RENDER_ORIGIN || request.method() !== "GET") {
        await route.abort("blockedbyclient");
        return;
      }
      const file = pageFile(pageDir, url.pathname);
      const body = file ? await readFile(file).catch(() => null) : null;
      if (!file || !body) {
        await route.fulfill({ status: 404, body: "" });
        return;
      }
      await route.fulfill({
        status: 200,
        body,
        contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        headers: file.endsWith(".html") ? { "content-security-policy": CSP } : {},
      });
    });
    const page = await context.newPage();
    page.on("crash", () => {
      crashed = true;
    });
    await page.goto(`${RENDER_ORIGIN}/index.html`, {
      waitUntil: "load",
      timeout: options.timeoutMs,
    });
    const ready = await page.evaluate(() => typeof window.ddlRenderDrawing === "function");
    if (!ready) throw new DrawingRenderError("The drawing render page didn't load.");
    return {
      render: (input) => page.evaluate((arg) => window.ddlRenderDrawing!(arg), input),
      close: () => browser.close(),
      get closed() {
        return crashed || page.isClosed() || !browser.isConnected();
      },
    };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/** The file a request path names inside the page directory, or null outside it. */
export function pageFile(pageDir: string, pathname: string): string | null {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  const file = normalize(join(pageDir, relative || "index.html"));
  return file.startsWith(pageDir.endsWith(sep) ? pageDir : `${pageDir}${sep}`) ? file : null;
}

/** The images a scene's image elements show (the only files worth sending to the page). */
function filesOf(
  scene: DrawingScene,
  elements: readonly DrawingElement[],
): Record<string, unknown> {
  const used = new Set(
    elements.flatMap((element) =>
      element.type === "image" && typeof element.fileId === "string" ? [element.fileId] : [],
    ),
  );
  return Object.fromEntries(Object.entries(scene.files ?? {}).filter(([id]) => used.has(id)));
}

/** Width and height from a PNG's IHDR chunk; undefined when it isn't a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte)) return undefined;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").slice(0, 300);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
