// Builds the page the daemon renders drawings with (see src/drawings/chromium-renderer.ts):
// index.html, render.js (src/drawings/render-page bundled with Excalidraw for the browser), the
// fonts Excalidraw draws text with, and version.json, whose `build` hash keys the render cache.
// Everything is served to headless Chromium from this directory: the page fetches nothing else.
//
//   node packages/agent/scripts/build-drawing-renderer.mjs <out dir>
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const PAGE_DIR = fileURLToPath(new URL("../src/drawings/render-page/", import.meta.url));
/** Excalidraw's CJK font is 12 of its 13 MB; without it CJK text renders in the system font. */
const SKIPPED_FONTS = new Set(["Xiaolai"]);

/**
 * Excalidraw loads its Mermaid converter (about 6 MB with its diagram types) only for the editor's
 * text-to-diagram dialog, never to export: the page gets an empty module instead.
 */
const withoutMermaid = {
  name: "without-mermaid",
  setup(build) {
    build.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, () => ({
      path: "mermaid-to-excalidraw",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export {};" }));
  },
};

/** Builds the page into `outDir` (replacing what's there) and returns its version. */
export async function buildDrawingRenderer(outDir, { logLevel = "warning" } = {}) {
  const entry = fileURLToPath(import.meta.resolve("@excalidraw/excalidraw"));
  const packageDir = resolve(dirname(entry), "../..");
  const { version } = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: { render: join(PAGE_DIR, "render.ts") },
    outdir: outDir,
    // Excalidraw's locales and diagram converters load on demand: chunks the page never fetches.
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    conditions: ["production"],
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    legalComments: "none",
    logLevel,
    plugins: [withoutMermaid],
  });
  await cp(join(packageDir, "dist/prod/fonts"), join(outDir, "fonts"), {
    recursive: true,
    filter: (source) => !SKIPPED_FONTS.has(source.split(/[\\/]/).pop() ?? ""),
  });
  await copyFile(join(PAGE_DIR, "index.html"), join(outDir, "index.html"));
  // A classic script, so it runs before the module's imports: Excalidraw reads it when it
  // registers its fonts.
  await writeFile(
    join(outDir, "asset-path.js"),
    'window.EXCALIDRAW_ASSET_PATH = location.origin + "/";\n',
  );
  await copyFile(join(PAGE_DIR, "NOTICE.md"), join(outDir, "NOTICE.md"));
  const script = await readFile(join(outDir, "render.js"));
  const buildHash = createHash("sha256").update(version).update(script).digest("hex").slice(0, 16);
  const info = { excalidraw: version, build: buildHash };
  await writeFile(join(outDir, "version.json"), `${JSON.stringify(info)}\n`);
  return info;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: build-drawing-renderer.mjs <out dir>");
    process.exit(1);
  }
  const info = await buildDrawingRenderer(resolve(outDir));
  console.log(`drawing renderer ${info.build} (Excalidraw ${info.excalidraw}) → ${outDir}`);
}
