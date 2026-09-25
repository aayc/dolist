/**
 * The drawing renderer in real headless Chromium, on the page the daemon's build makes. Skipped
 * where no Chromium-based browser is installed, like the agent browser's own tests.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDrawingRenderer } from "../../../scripts/build-drawing-renderer.mjs";
import { flowchartScene } from "../../testing/drawings";
import { resolveBrowserExecutable } from "./browser-executable";
import { ChromiumDrawingRenderer, pngSize } from "./drawing-renderer";

const resolved = resolveBrowserExecutable();
const TIMEOUT = 60_000;

describe.skipIf(!resolved)("ChromiumDrawingRenderer (real Chromium)", () => {
  let root: string;
  let renderer: ChromiumDrawingRenderer;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ddl-renderer-"));
    await buildDrawingRenderer(join(root, "page"), { logLevel: "error" });
    renderer = new ChromiumDrawingRenderer({
      pageDir: join(root, "page"),
      cacheDir: join(root, "cache"),
      executablePath: resolved!.executablePath,
      timeoutMs: 45_000,
    });
  }, TIMEOUT);

  afterAll(async () => {
    await renderer?.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it(
    "renders a drawing to a PNG no larger than 1,280 px, then serves it from the cache",
    async () => {
      const scene = flowchartScene({
        boxes: ["Landing", "Sign up form", "Verify email", "Dashboard"],
        arrows: [
          ["Landing", "Sign up form"],
          ["Sign up form", "Verify email", "submit"],
          ["Verify email", "Dashboard"],
        ],
        notes: ["Draft"],
      });
      const image = await renderer.render(scene);
      const bytes = Buffer.from(image.data, "base64");
      expect(pngSize(bytes)).toEqual({ width: image.width, height: image.height });
      expect(image.width).toBe(1280);
      expect(image.height).toBeGreaterThan(100);
      expect(image.height).toBeLessThan(image.width);
      expect(bytes.length).toBeGreaterThan(5_000);
      expect(image.cached).toBe(false);

      const again = await renderer.render(scene);
      expect(again).toMatchObject({ cached: true, width: image.width, height: image.height });
    },
    TIMEOUT,
  );

  it(
    "scales a small drawing up, at most twice",
    async () => {
      const small = await renderer.render(flowchartScene({ boxes: ["Only box"] }));
      // 180×80 plus 16 px of padding on each side, doubled.
      expect(small).toMatchObject({ width: 424, height: 224 });
    },
    TIMEOUT,
  );
});
