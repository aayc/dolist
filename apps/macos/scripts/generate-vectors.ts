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
 * generated corpus; regenerate and commit. `--check` compares parsed JSON, so formatting (owned by
 * Biome) never makes the files stale.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as core from "../../../packages/core/src/index.ts";
import { PINNED_NOW_MS, pinClock, VECTOR_TIME_ZONE } from "./vectors/common";
import { buildDailyNoteVectors, buildTemplateVectors } from "./vectors/daily-notes";
import { buildDateFormatVectors, buildDateParseVectors } from "./vectors/dates";
import { buildPathVectors } from "./vectors/paths";
import { buildTaskVectors } from "./vectors/tasks";
import { buildTextVectors } from "./vectors/text";
import { buildAnchorVectors, buildTrackerVectors } from "./vectors/tracker";
import { buildWikiLinkVectors } from "./vectors/wikilinks";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
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

function main(): void {
  const check = process.argv.includes("--check");
  const generated = builders.map(([name, build]) => {
    const json = `${JSON.stringify(build(), null, 2)}\n`;
    return { name, path: `${vectorDir}${name}`, json, value: JSON.parse(json) as unknown };
  });

  if (check) {
    let stale = 0;
    for (const file of generated) {
      if (!existsSync(file.path)) {
        console.error(`✗ ${file.name}: missing`);
        stale++;
        continue;
      }
      const details: string[] = [];
      const count = diffJson(JSON.parse(readFileSync(file.path, "utf8")), file.value, "", details);
      if (count === 0) continue;
      stale++;
      console.error(`✗ ${file.name}: ${count} difference(s)`);
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
  for (const file of generated) writeFileSync(file.path, file.json);
  try {
    execFileSync("pnpm", ["exec", "biome", "format", "--write", ...generated.map((f) => f.path)], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    console.warn("biome format failed; run `pnpm lint:fix` before committing");
  }
  for (const file of generated) {
    console.log(`wrote ${file.name} (${Math.round(readFileSync(file.path).length / 1024)} KiB)`);
  }
}

main();
