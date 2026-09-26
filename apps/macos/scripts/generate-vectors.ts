/**
 * Cross-language test vectors for the Swift package apps/macos/Packages/DailyDoListDomain.
 *
 *   pnpm exec tsx apps/macos/scripts/generate-vectors.ts          # regenerate the JSON files
 *   pnpm exec tsx apps/macos/scripts/generate-vectors.ts --check  # CI: exit 1 if they are stale
 *
 * Runs the TypeScript core (imported from source, no build step) on a fixed corpus and writes the
 * results to Tests/DailyDoListDomainTests/Vectors/, where the Swift tests assert that the port
 * produces exactly the same output. Output is deterministic: a fixed time zone, a pinned clock
 * (`new Date()` / `Date.now()`) and fixed fast-check seeds. Bumping fast-check may change the
 * generated corpus; regenerate and commit. The files are JSON with one case per line (Biome
 * ignores them), and `--check` compares their exact text.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as core from "../../../packages/core/src/index.ts";
import { buildAgentTextVectors, buildMergeVectors } from "./vectors/agent-text";
import { PINNED_NOW_MS, pinClock, VECTOR_TIME_ZONE } from "./vectors/common";
import { buildDailyNoteVectors, buildTemplateVectors } from "./vectors/daily-notes";
import { buildDateFormatVectors, buildDateParseVectors } from "./vectors/dates";
import { buildPathVectors } from "./vectors/paths";
import { buildTaskVectors } from "./vectors/tasks";
import { buildTextVectors } from "./vectors/text";
import { buildAnchorVectors, buildTrackerVectors } from "./vectors/tracker";
import { buildWikiLinkVectors } from "./vectors/wikilinks";

const vectorDir = fileURLToPath(
  new URL("../Packages/DailyDoListDomain/Tests/DailyDoListDomainTests/Vectors/", import.meta.url),
);

process.env.TZ = VECTOR_TIME_ZONE;
pinClock(PINNED_NOW_MS);

const builders: Array<[string, () => unknown]> = [
  ["dates-format.json", () => buildDateFormatVectors(core)],
  ["dates-parse.json", () => buildDateParseVectors(core)],
  ["daily-notes.json", () => buildDailyNoteVectors(core)],
  ["template.json", () => buildTemplateVectors(core)],
  ["paths.json", () => buildPathVectors(core)],
  ["text.json", () => buildTextVectors(core)],
  ["wikilinks.json", () => buildWikiLinkVectors(core)],
  ["tasks.json", () => buildTaskVectors(core)],
  ["tracker.json", () => buildTrackerVectors(core)],
  ["anchors.json", () => buildAnchorVectors(core)],
  ["agent-text.json", () => buildAgentTextVectors(core)],
  ["merge.json", () => buildMergeVectors(core)],
];

/** Collects up to `limit` JSON paths where `a` and `b` differ. */
function diffJson(a: unknown, b: unknown, path: string, out: string[], limit = 5): number {
  if (Object.is(a, b)) return 0;
  const bothObjects = typeof a === "object" && typeof b === "object" && a !== null && b !== null;
  if (!bothObjects || Array.isArray(a) !== Array.isArray(b)) {
    if (out.length < limit) out.push(`${path || "$"}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    return 1;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let count = 0;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const child = Array.isArray(a) ? `${path}[${key}]` : `${path}.${key}`;
    count += diffJson(left[key], right[key], child, out, limit);
  }
  return count;
}

/** JSON with one case per line: the top two levels of objects and their arrays are spread out. */
function layout(value: unknown, indent = ""): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[\n${value.map((item) => inner + JSON.stringify(item)).join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null && indent.length < 4) {
    const entries = Object.entries(value).map(
      ([key, item]) => `${inner}${JSON.stringify(key)}: ${layout(item, inner)}`,
    );
    return `{\n${entries.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function main(): void {
  const check = process.argv.includes("--check");
  const generated = builders.map(([name, build]) => {
    // Round-tripped so that `undefined` is dropped exactly as JSON.stringify drops it.
    const value: unknown = JSON.parse(JSON.stringify(build()));
    return { name, path: `${vectorDir}${name}`, json: `${layout(value)}\n`, value };
  });

  if (check) {
    let stale = 0;
    for (const file of generated) {
      if (!existsSync(file.path)) {
        console.error(`✗ ${file.name}: missing`);
        stale++;
        continue;
      }
      const text = readFileSync(file.path, "utf8");
      if (text === file.json) continue;
      stale++;
      const details: string[] = [];
      const count = diffJson(JSON.parse(text), file.value, "", details);
      console.error(
        `✗ ${file.name}: ${count ? `${count} difference(s)` : "not in the generated layout"}`,
      );
      for (const line of details) console.error(`    ${line.slice(0, 300)}`);
    }
    if (stale > 0) {
      console.error(
        `\n${stale} vector file(s) are stale. Regenerate with: pnpm exec tsx apps/macos/scripts/generate-vectors.ts`,
      );
      process.exit(1);
    }
    console.log(`✓ ${generated.length} vector files are up to date`);
    return;
  }

  mkdirSync(vectorDir, { recursive: true });
  for (const file of generated) {
    writeFileSync(file.path, file.json);
    console.log(`wrote ${file.name} (${Math.round(Buffer.byteLength(file.json) / 1024)} KiB)`);
  }
}

main();
