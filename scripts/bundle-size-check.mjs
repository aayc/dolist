#!/usr/bin/env node
/**
 * Bundle-size budget for the web app; run after `vite build` (CI: `pnpm build`).
 *
 * "Initial" = the HTML entry chunk plus everything it statically imports, i.e. what the browser
 * must download before the app boots. It is resolved from `dist/.vite/manifest.json` (Vite
 * `build.manifest: true`) or, without a manifest, from the script/modulepreload/stylesheet tags in
 * `dist/index.html`. Sizes are gzip (node:zlib default level) in kB of 1000 bytes, the same units
 * Vite prints in its build report.
 *
 *   node scripts/bundle-size-check.mjs [--dist apps/web/dist]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { markdownTable, REPO_ROOT, textTable, writeStepSummary } from "./lib/report.mjs";

/**
 * Budgets in kB (gzip). Initial JS is dominated by CodeMirror core + @codemirror/lang-markdown,
 * which statically embeds lang-html (and with it the JS/CSS parsers, ~60 kB gz). Vim is lazy.
 */
const BUDGET_KB = {
  initialJs: 320,
  initialCss: 40,
  totalJs: 1300,
};
const KB = 1000;
const LARGEST_CHUNKS_SHOWN = 10;

const JS_FILE = /\.(?:js|mjs|cjs)$/;
const CSS_FILE = /\.css$/;

const distFlag = process.argv.indexOf("--dist");
const DIST = resolve(REPO_ROOT, distFlag === -1 ? "apps/web/dist" : process.argv[distFlag + 1]);
const DIST_SHOWN = relative(REPO_ROOT, DIST) || ".";
const MANIFEST = join(DIST, ".vite", "manifest.json");
const INDEX_HTML = join(DIST, "index.html");

function fail(message) {
  console.error(`✖ bundle-size-check: ${message}`);
  writeStepSummary(`### Bundle size (${DIST_SHOWN})\n\n❌ ${message}`);
  process.exit(1);
}

/** Entry chunk(s) + transitive static imports, from Vite's build manifest. */
function initialFromManifest(manifest) {
  const entries = Object.values(manifest).filter((chunk) => chunk.isEntry);
  const htmlEntries = entries.filter((chunk) => chunk.src?.endsWith(".html"));
  const js = new Set();
  const css = new Set();
  const seen = new Set();
  const visit = (chunk) => {
    if (!chunk || seen.has(chunk)) return;
    seen.add(chunk);
    if (JS_FILE.test(chunk.file)) js.add(chunk.file);
    else if (CSS_FILE.test(chunk.file)) css.add(chunk.file);
    for (const file of chunk.css ?? []) css.add(file);
    for (const key of chunk.imports ?? []) visit(manifest[key]);
  };
  for (const entry of htmlEntries.length > 0 ? htmlEntries : entries) visit(entry);
  return { js: [...js], css: [...css] };
}

function parseAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
  )) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

/** Maps a URL from index.html to a path relative to dist; undefined for external URLs. */
function toDistPath(url) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return undefined;
  const path = posix.normalize(url.split(/[?#]/)[0].replace(/^\.?\/+/, ""));
  return path.startsWith("..") ? undefined : path;
}

function addLocalPath(bucket, url) {
  const path = url && toDistPath(url);
  if (path) bucket.add(path);
}

/** Fallback: the module script, modulepreload links and stylesheets referenced by index.html. */
function initialFromHtml(html) {
  const js = new Set();
  const css = new Set();
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    const attributes = parseAttributes(tag);
    const rel = (attributes.rel ?? "").toLowerCase().split(/\s+/);
    if (/^<script/i.test(tag)) {
      if (attributes.type === "module") addLocalPath(js, attributes.src);
    } else if (rel.includes("modulepreload")) {
      addLocalPath(js, attributes.href);
    } else if (rel.includes("stylesheet")) {
      addLocalPath(css, attributes.href);
    }
  }
  return { js: [...js], css: [...css] };
}

function listFiles(dir, pattern, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path, pattern, base));
    else if (entry.isFile() && pattern.test(entry.name)) files.push(relative(base, path));
  }
  return files;
}

const sizeCache = new Map();
function sizeOf(file) {
  let size = sizeCache.get(file);
  if (!size) {
    const contents = readFileSync(join(DIST, file));
    size = { raw: contents.length, gzip: gzipSync(contents).length };
    sizeCache.set(file, size);
  }
  return size;
}

function total(files) {
  return files.reduce(
    (sum, file) => {
      const size = sizeOf(file);
      return { raw: sum.raw + size.raw, gzip: sum.gzip + size.gzip };
    },
    { raw: 0, gzip: 0 },
  );
}

const kb = (bytes) => `${(bytes / KB).toFixed(1)} kB`;

if (!existsSync(DIST) || (!existsSync(MANIFEST) && !existsSync(INDEX_HTML))) {
  fail(
    `no build output at ${DIST_SHOWN} — build the web app first (\`pnpm --filter @ddl/web build\`, or \`pnpm build\`).`,
  );
}

let initial;
let source;
if (existsSync(MANIFEST)) {
  initial = initialFromManifest(JSON.parse(readFileSync(MANIFEST, "utf8")));
  source = "`.vite/manifest.json`";
} else {
  initial = initialFromHtml(readFileSync(INDEX_HTML, "utf8"));
  source = "`index.html` tags — set `build.manifest: true` in the Vite config for exact results";
}

const missing = [...initial.js, ...initial.css].filter((file) => !existsSync(join(DIST, file)));
if (missing.length > 0)
  fail(`initial assets referenced but not found in ${DIST_SHOWN}: ${missing.join(", ")}`);
if (initial.js.length === 0) fail(`could not determine the initial JS chunks from ${source}.`);

const allJs = listFiles(DIST, JS_FILE).filter((file) => !file.startsWith(".vite"));
const metrics = [
  { label: "Initial JS", files: initial.js, budget: BUDGET_KB.initialJs },
  { label: "Initial CSS", files: initial.css, budget: BUDGET_KB.initialCss },
  { label: "Total JS", files: allJs, budget: BUDGET_KB.totalJs },
].map((metric) => {
  const size = total(metric.files);
  const over = size.gzip - metric.budget * KB;
  return { ...metric, size, over };
});

const COLUMNS = [
  { header: "Bundle" },
  { header: "Files", align: "right" },
  { header: "Raw", align: "right" },
  { header: "Gzip", align: "right" },
  { header: "Budget (gzip)", align: "right" },
  { header: "Status" },
];
const cells = (metric, markdown) => [
  metric.label,
  metric.files.length,
  kb(metric.size.raw),
  kb(metric.size.gzip),
  `${metric.budget} kB`,
  metric.over > 0
    ? `${markdown ? "❌ " : ""}over by ${kb(metric.over)}`
    : `${markdown ? "✅ " : ""}${Math.round((metric.size.gzip / (metric.budget * KB)) * 100)}% of budget`,
];

const initialSet = new Set(initial.js);
const largest = [...allJs]
  .sort((a, b) => sizeOf(b).gzip - sizeOf(a).gzip)
  .slice(0, LARGEST_CHUNKS_SHOWN);
const CHUNK_COLUMNS = [
  { header: "Chunk" },
  { header: "Raw", align: "right" },
  { header: "Gzip", align: "right" },
  { header: "Initial" },
];
const chunkCells = largest.map((file) => [
  file,
  kb(sizeOf(file).raw),
  kb(sizeOf(file).gzip),
  initialSet.has(file) ? "yes" : "",
]);

console.log(`Bundle size: ${DIST_SHOWN} (initial chunks from ${source.replaceAll("`", "")})\n`);
console.log(
  textTable(
    COLUMNS,
    metrics.map((metric) => cells(metric, false)),
  ),
);
console.log(`\nLargest JS chunks:\n${textTable(CHUNK_COLUMNS, chunkCells)}`);

writeStepSummary(
  [
    `### Bundle size (${DIST_SHOWN})`,
    `Initial chunks resolved from ${source}. Sizes in kB (1000 bytes), gzip.`,
    markdownTable(
      COLUMNS,
      metrics.map((metric) => cells(metric, true)),
    ),
    `<details><summary>Largest JS chunks</summary>\n\n${markdownTable(CHUNK_COLUMNS, chunkCells)}\n\n</details>`,
  ].join("\n\n"),
);

const violations = metrics.filter((metric) => metric.over > 0);
if (violations.length > 0) {
  console.error(
    `\n✖ bundle-size-check: over budget: ${violations
      .map((metric) => `${metric.label} ${kb(metric.size.gzip)} > ${metric.budget} kB`)
      .join("; ")}`,
  );
  process.exit(1);
}
console.log("\n✔ bundle-size-check: all bundles within budget.");
