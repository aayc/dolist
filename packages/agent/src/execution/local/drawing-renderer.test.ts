import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderCache } from "../../drawings/render-cache";
import type { RenderPageInput } from "../../drawings/render-page/protocol";
import { DrawingRenderError } from "../../drawings/renderer";
import { flowchartScene } from "../../testing/drawings";
import {
  ChromiumDrawingRenderer,
  type OpenRenderPageOptions,
  pageFile,
  pngSize,
  type RenderPage,
} from "./drawing-renderer";

const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ddl-render-"));
  dirs.push(dir);
  return dir;
}

/** A minimal valid PNG of the given size (IHDR is all `pngSize` reads). */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(1))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

interface FakePages {
  opened: OpenRenderPageOptions[];
  inputs: RenderPageInput[];
  pages: Array<RenderPage & { closedByUs: boolean; crash(): void }>;
  open(options: OpenRenderPageOptions): Promise<RenderPage>;
  /** What the next render does (default: a 640×240 PNG). */
  next:
    | ((input: RenderPageInput) => Promise<{ data: string; width: number; height: number }>)
    | null;
}

function fakePages(): FakePages {
  const fake: FakePages = {
    opened: [],
    inputs: [],
    pages: [],
    next: null,
    async open(options) {
      fake.opened.push(options);
      let crashed = false;
      const page = {
        closedByUs: false,
        crash: () => {
          crashed = true;
        },
        get closed() {
          return crashed || page.closedByUs;
        },
        async render(input: RenderPageInput) {
          fake.inputs.push(input);
          const step = fake.next;
          fake.next = null;
          if (step) return step(input);
          return { data: png(640, 240).toString("base64"), width: 640, height: 240 };
        },
        async close() {
          page.closedByUs = true;
        },
      };
      fake.pages.push(page);
      return page;
    },
  };
  return fake;
}

async function setup(options: { idleMs?: number; timeoutMs?: number } = {}) {
  const pageDir = await tempDir();
  await writeFile(join(pageDir, "version.json"), JSON.stringify({ build: "b1" }));
  const cacheDir = join(await tempDir(), "cache");
  const pages = fakePages();
  const renderer = new ChromiumDrawingRenderer({
    pageDir,
    cacheDir,
    executablePath: "/fake/chrome",
    openPage: (o) => pages.open(o),
    ...options,
  });
  return { renderer, pages, pageDir, cacheDir };
}

const SCENE = flowchartScene({ boxes: ["Login", "Dashboard"], arrows: [["Login", "Dashboard"]] });

describe("ChromiumDrawingRenderer", () => {
  it("opens the page on first use and renders on a light background, capped in size", async () => {
    const { renderer, pages } = await setup();
    expect(pages.opened).toEqual([]);
    const image = await renderer.render(SCENE);
    expect(image).toMatchObject({ mimeType: "image/png", width: 640, height: 240, cached: false });
    expect(pngSize(Buffer.from(image.data, "base64"))).toEqual({ width: 640, height: 240 });
    expect(pages.opened).toEqual([
      expect.objectContaining({ executablePath: "/fake/chrome", timeoutMs: 30_000 }),
    ]);
    expect(pages.inputs[0]).toMatchObject({
      maxSize: 1280,
      maxScale: 2,
      background: "#ffffff",
      files: {},
    });
    expect(pages.inputs[0]!.elements).toHaveLength(SCENE.elements.length);
    await renderer.dispose();
  });

  it("serves the same drawing from the cache, across renderers, without opening a page", async () => {
    const { renderer, pages, pageDir, cacheDir } = await setup();
    await renderer.render(SCENE);
    const again = await renderer.render(structuredClone(SCENE));
    expect(again.cached).toBe(true);
    expect(pages.inputs).toHaveLength(1);
    await renderer.dispose();

    const other = fakePages();
    const restarted = new ChromiumDrawingRenderer({
      pageDir,
      cacheDir,
      executablePath: "/fake/chrome",
      openPage: (o) => other.open(o),
    });
    expect((await restarted.render(SCENE)).cached).toBe(true);
    expect(other.opened).toEqual([]);
    expect((await restarted.render(SCENE, { maxSize: 800 })).cached).toBe(false);
    await restarted.dispose();
  });

  it("renders again when the page is rebuilt (another Excalidraw)", async () => {
    const { renderer, pages, pageDir, cacheDir } = await setup();
    await renderer.render(SCENE);
    await writeFile(join(pageDir, "version.json"), JSON.stringify({ build: "b2" }));
    const rebuilt = new ChromiumDrawingRenderer({
      pageDir,
      cacheDir,
      executablePath: "/fake/chrome",
      openPage: (o) => pages.open(o),
    });
    expect((await rebuilt.render(SCENE)).cached).toBe(false);
    await Promise.all([renderer.dispose(), rebuilt.dispose()]);
  });

  it("refuses empty drawings, and output that isn't a PNG of the right size", async () => {
    const { renderer, pages } = await setup();
    await expect(renderer.render({ ...SCENE, elements: [] })).rejects.toThrow("empty");
    pages.next = async () => ({
      data: Buffer.from("<html>").toString("base64"),
      width: 1,
      height: 1,
    });
    await expect(renderer.render(SCENE)).rejects.toThrow("something other than a PNG");
    pages.next = async () => ({ data: png(4000, 10).toString("base64"), width: 4000, height: 10 });
    await expect(renderer.render(SCENE)).rejects.toThrow(DrawingRenderError);
    await renderer.dispose();
  });

  it("starts a new browser after a render times out or the page crashes", async () => {
    const { renderer, pages } = await setup({ timeoutMs: 50 });
    pages.next = () => new Promise(() => {});
    await expect(renderer.render(SCENE)).rejects.toThrow("took too long");
    expect(pages.pages[0]!.closedByUs).toBe(true);
    await renderer.render(SCENE);
    expect(pages.opened).toHaveLength(2);

    pages.pages[1]!.crash();
    await renderer.render(flowchartScene({ boxes: ["Other"] }));
    expect(pages.opened).toHaveLength(3);
    await renderer.dispose();
  });

  it("keeps the page after a render the scene broke", async () => {
    const { renderer, pages } = await setup();
    pages.next = async () => {
      throw new Error("Evaluation failed: TypeError: bad element\n    at stack");
    };
    await expect(renderer.render(SCENE)).rejects.toThrow(
      "Evaluation failed: TypeError: bad element",
    );
    await renderer.render(SCENE);
    expect(pages.opened).toHaveLength(1);
    await renderer.dispose();
  });

  it("closes the browser once it has been idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { renderer, pages } = await setup({ idleMs: 1_000 });
    await renderer.render(SCENE);
    await vi.advanceTimersByTimeAsync(900);
    expect(pages.pages[0]!.closedByUs).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(pages.pages[0]!.closedByUs).toBe(true);
    await renderer.render(flowchartScene({ boxes: ["Next"] }));
    expect(pages.opened).toHaveLength(2);
    await renderer.dispose();
    expect(pages.pages[1]!.closedByUs).toBe(true);
  });

  it("gives up waiting when the caller aborts", async () => {
    const { renderer, pages } = await setup();
    let finish: () => void = () => {};
    pages.next = () =>
      new Promise((resolve) => {
        finish = () => resolve({ data: png(10, 10).toString("base64"), width: 10, height: 10 });
      });
    const controller = new AbortController();
    const rendering = renderer.render(SCENE, { signal: controller.signal });
    await vi.waitFor(() => expect(pages.inputs).toHaveLength(1));
    controller.abort(new Error("stopped"));
    await expect(rendering).rejects.toThrow("stopped");
    finish();
    await renderer.dispose();
  });
});

describe("pageFile", () => {
  it("maps request paths into the page directory and nowhere else", () => {
    expect(pageFile("/srv/page", "/")).toBe("/srv/page/index.html");
    expect(pageFile("/srv/page", "/fonts/Excalifont/A.woff2")).toBe(
      "/srv/page/fonts/Excalifont/A.woff2",
    );
    expect(pageFile("/srv/page", "/../secret.txt")).toBeNull();
    expect(pageFile("/srv/page", "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
    expect(pageFile("/srv/page", "/%E0%A4%A")).toBeNull();
  });
});

describe("RenderCache", () => {
  it("evicts the least recently used renders past its size", async () => {
    const dir = join(await tempDir(), "cache");
    let now = 1_000;
    const cache = new RenderCache({ dir, maxBytes: 250, now: () => now });
    const key = (n: number) => String(n).repeat(16);
    await cache.put(key(1), Buffer.alloc(100));
    now += 10;
    await cache.put(key(2), Buffer.alloc(100));
    now += 10;
    expect(await cache.get(key(1))).not.toBeNull();
    now += 10;
    await cache.put(key(3), Buffer.alloc(100));
    expect((await readdir(dir)).sort()).toEqual([`${key(1)}.png`, `${key(3)}.png`]);
    expect(await cache.get(key(2))).toBeNull();

    const reloaded = new RenderCache({ dir, maxBytes: 250 });
    expect(await reloaded.get(key(3))).not.toBeNull();
  });
});
