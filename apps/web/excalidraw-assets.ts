/**
 * Build support for `@excalidraw/excalidraw`, which the drawings feature loads on demand.
 *
 * - Its drawing fonts are served by our build (never a CDN): in dev from `node_modules`, in the
 *   build as files under `assets/excalidraw-<version>/`, with the license notices next to them.
 *   `window.EXCALIDRAW_ASSET_PATH` points there (`src/features/drawings/excalidraw-loader.ts`).
 * - Parts of the package we don't ship are replaced with small modules: font subsetting
 *   (HarfBuzz and WOFF2 compiled to WebAssembly, ~740 kB gzip, used only when exporting from
 *   Excalidraw's menus; exports embed whole fonts instead), the Mermaid importer (Mermaid is
 *   several MB), the image downscaler, the compressor of scenes embedded in exported images, and
 *   the translations (the app is English only). None of them needs WebAssembly, so the daemon's
 *   CSP stays without `wasm-unsafe-eval`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
/** `dist/prod` of the installed package. */
const PROD_DIR = dirname(require.resolve("@excalidraw/excalidraw"));
const PACKAGE_DIR = resolve(PROD_DIR, "../..");
const FONTS_DIR = join(PROD_DIR, "fonts");
const DIST_DIR = resolve(PROD_DIR, "..");
const NOTICE_FILE = new URL("./excalidraw-notice.txt", import.meta.url);

export const EXCALIDRAW_VERSION = (
  JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }
).version;

/** Where the fonts are served, relative to the app's base URL (versioned, so cacheable forever). */
export const EXCALIDRAW_ASSET_DIR = `assets/excalidraw-${EXCALIDRAW_VERSION}/`;

const STUB_PREFIX = "\0ddl-excalidraw:";

const STUBS: Record<string, string> = {
  "subset-shared": `
export const Commands = { Subset: "SUBSET" };
export async function toBase64(arrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return "data:font/woff2;base64," + btoa(binary);
}
export async function subsetToBinary(arrayBuffer) {
  return arrayBuffer;
}
export async function subsetToBase64(arrayBuffer) {
  return toBase64(arrayBuffer);
}
`,
  // Excalidraw runs this chunk as a module worker; answering with the whole font keeps exports
  // working without the WebAssembly subsetter.
  "subset-worker": `
export const WorkerUrl = import.meta.url ? new URL(import.meta.url) : undefined;
if (typeof window === "undefined" && typeof self !== "undefined") {
  self.onmessage = (event) => {
    const { arrayBuffer } = event.data;
    self.postMessage(arrayBuffer, { transfer: [arrayBuffer] });
  };
}
`,
  mermaid: `
export async function parseMermaidToExcalidraw() {
  throw new Error("Mermaid diagrams can't be imported in Daily Do List yet.");
}
`,
  // Excalidraw shrinks pasted images with pica and image-blob-reduce (~29 kB gzip, and pica's
  // WebAssembly needs a CSP exception). A canvas does the same job here.
  pica: `
export default function pica() {
  return {
    toBlob(canvas, type, quality) {
      return new Promise((resolve, reject) =>
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't encode the image"))), type, quality),
      );
    },
  };
}
`,
  "image-blob-reduce": `
export default function imageBlobReduce({ pica }) {
  return {
    pica,
    _create_blob(env) {
      return this.pica.toBlob(env.out_canvas, env.type).then((blob) => {
        env.out_blob = blob;
        return env;
      });
    },
    async toBlob(file, { max }) {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const env = await this._create_blob({ out_canvas: canvas, type: file.type });
      return env.out_blob;
    },
  };
}
`,
  // pako (~14 kB gzip) only compresses the scene Excalidraw embeds in exported images; without it
  // Excalidraw embeds the scene uncompressed (its own fallback). Images whose embedded scene is
  // compressed can't be opened as a scene.
  pako: `
export function deflate() {
  throw new Error("Compression isn't available");
}
export function inflate() {
  throw new Error("This image's drawing data is compressed, which Daily Do List can't read yet.");
}
`,
  // browser-fs-access (~2 kB gzip) opens and saves files; Excalidraw only opens images here (its
  // load, save and export menus are off). This is the input-element fallback the library itself
  // uses where the File System Access API isn't available.
  "browser-fs-access": `
export const supported = false;
export function fileOpen(options = {}) {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = [...(options.mimeTypes ?? []), ...(options.extensions ?? [])].join(",");
    input.multiple = Boolean(options.multiple);
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      resolve(options.multiple ? files : files[0]);
    });
    input.addEventListener("cancel", () =>
      reject(new DOMException("The user aborted a request.", "AbortError")),
    );
    input.click();
  });
}
export async function fileSave(blob, options = {}) {
  const link = document.createElement("a");
  link.download = options.fileName ?? "Untitled";
  link.href = URL.createObjectURL(await blob);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 30_000);
  return null;
}
`,
  // Loaded only where canvas lacks roundRect (Safari before 16), which the app doesn't run on.
  "canvas-roundrect-polyfill": "export {};\n",
  locale: "export default {};\n",
};

const REPLACED_PACKAGES = new Set([
  "pica",
  "image-blob-reduce",
  "pako",
  "browser-fs-access",
  "canvas-roundrect-polyfill",
]);

function isInsidePackage(importer: string | undefined): boolean {
  return importer !== undefined && resolve(importer).startsWith(`${DIST_DIR}${sep}`);
}

function stubFor(source: string, importer: string | undefined): string | null {
  if (!isInsidePackage(importer)) return null;
  if (source === "@excalidraw/mermaid-to-excalidraw") return "mermaid";
  if (REPLACED_PACKAGES.has(source)) return source;
  if (/(?:^|\/)subset-shared\.chunk\.js$/.test(source)) return "subset-shared";
  if (/(?:^|\/)subset-worker\.chunk\.js$/.test(source)) return "subset-worker";
  if (/(?:^|\/)locales\/(?!en-)[^/]+\.js$/.test(source)) return "locale";
  return null;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export function excalidrawAssets(): Plugin {
  let base = "/";
  return {
    name: "ddl-excalidraw-assets",
    enforce: "pre",
    configResolved(config) {
      base = config.base;
    },
    resolveId(source, importer) {
      const stub = stubFor(source, importer);
      return stub ? `${STUB_PREFIX}${stub}` : null;
    },
    load(id) {
      if (!id.startsWith(STUB_PREFIX)) return null;
      return STUBS[id.slice(STUB_PREFIX.length)] ?? null;
    },
    configureServer(server) {
      const prefix = `${base}${EXCALIDRAW_ASSET_DIR}`;
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith(prefix)) return next();
        const file = resolve(PROD_DIR, decodeURIComponent(url.slice(prefix.length)));
        if (!file.startsWith(`${FONTS_DIR}${sep}`) || !statSync(file, { throwIfNoEntry: false })) {
          return next();
        }
        res.setHeader("Content-Type", "font/woff2");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const file of listFiles(FONTS_DIR)) {
        this.emitFile({
          type: "asset",
          fileName: `${EXCALIDRAW_ASSET_DIR}${relative(PROD_DIR, file).split(sep).join("/")}`,
          source: readFileSync(file),
        });
      }
      this.emitFile({
        type: "asset",
        fileName: `${EXCALIDRAW_ASSET_DIR}NOTICE.txt`,
        source: readFileSync(NOTICE_FILE),
      });
    },
  };
}
