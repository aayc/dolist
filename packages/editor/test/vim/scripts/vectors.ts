/**
 * `pnpm vim:vectors` regenerates vectors.jsonl. `--check` regenerates in memory and fails with a
 * summary when the committed file differs (or a case errors, or coverage has gaps).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVectors, serializeCase, type VectorCase } from "../format";
import { launchChromium } from "./browser";
import { type Generated, generateVectors } from "./generate";

export const VECTORS_PATH = fileURLToPath(new URL("../vectors.jsonl", import.meta.url));

export function summarizeDiff(committed: string, fresh: Generated): string[] {
  const lines: string[] = [];
  let parsed: ReturnType<typeof parseVectors>;
  try {
    parsed = parseVectors(committed);
  } catch (error) {
    return [`committed vectors.jsonl can't be parsed: ${String(error)}`];
  }
  const freshHeader = fresh.text.slice(0, fresh.text.indexOf("\n"));
  if (JSON.stringify(parsed.header) !== freshHeader) {
    lines.push(
      `header changed:\n  committed: ${JSON.stringify(parsed.header)}\n  generated: ${freshHeader}`,
    );
  }
  const before = new Map(parsed.cases.map((c) => [c.name, c]));
  const after = new Map(fresh.vectors.map((c) => [c.name, c]));
  const added = [...after.keys()].filter((name) => !before.has(name));
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const changed: Array<[VectorCase, VectorCase]> = [];
  for (const [name, vector] of after) {
    const old = before.get(name);
    if (old && serializeCase(old) !== serializeCase(vector)) changed.push([old, vector]);
  }
  const show = <T>(items: T[], format: (item: T) => string) =>
    items
      .slice(0, 20)
      .map(format)
      .concat(items.length > 20 ? [`  … and ${items.length - 20} more`] : []);
  if (added.length) lines.push(`${added.length} case(s) added:`, ...show(added, (n) => `  + ${n}`));
  if (removed.length)
    lines.push(`${removed.length} case(s) removed:`, ...show(removed, (n) => `  - ${n}`));
  if (changed.length) {
    lines.push(
      `${changed.length} case(s) changed:`,
      ...show(changed, ([old, vector]) => {
        const step = vector.steps.findIndex(
          (s, i) => JSON.stringify(s) !== JSON.stringify(old.steps[i]),
        );
        const oldStep = old.steps[step];
        const newStep = vector.steps[step];
        return [
          `  ~ ${vector.name} (step ${step + 1})`,
          `      committed: ${JSON.stringify(oldStep?.expect)}`,
          `      generated: ${JSON.stringify(newStep?.expect)}`,
        ].join("\n");
      }),
    );
  }
  return lines;
}

/** Tokens of commands that measure pixels horizontally (page motions keep the goal x). */
const PIXEL_KEYS = new Set([
  "<C-d>",
  "<C-u>",
  "<C-f>",
  "<C-b>",
  "<PageUp>",
  "<PageDown>",
  "<S-Up>",
  "<S-Down>",
]);
/** Display-line motions: `g` followed by one of these. */
const DISPLAY_LINE_KEYS = new Set(["j", "k", "0", "^", "$", "m", "M", "<Up>", "<Down>"]);

/**
 * Cases whose results could depend on the machine's fonts: a pixel-measuring command over text
 * outside the oracle font (printable ASCII), which each OS renders in its own fallback fonts.
 */
export function fontDependentCases(vectors: readonly VectorCase[]): string[] {
  return vectors
    .filter((vector) => {
      const keys = vector.steps.flatMap((step) => ("keys" in step ? step.keys : []));
      const measures = keys.some(
        (key, i) =>
          PIXEL_KEYS.has(key) || (key === "g" && DISPLAY_LINE_KEYS.has(keys[i + 1] ?? "")),
      );
      if (!measures) return false;
      const texts = [
        vector.doc,
        ...keys,
        ...vector.steps.flatMap((step) =>
          "api" in step ? step.api.args.filter((arg) => typeof arg === "string") : [],
        ),
      ];
      return texts.some((text) => /[^\x20-\x7e\t\n]/.test(text));
    })
    .map((vector) => vector.name);
}

export function coverageProblems(generated: Generated): string[] {
  const { coverage, errors } = generated;
  const problems: string[] = [];
  for (const { name, error } of errors) problems.push(`case ${name} threw:\n${error}`);
  const fontDependent = fontDependentCases(generated.vectors);
  if (fontDependent.length) {
    problems.push(
      `cases that measure pixels over text the oracle font doesn't cover (their results would ` +
        `depend on the OS's fallback fonts; keep them to printable ASCII): ${fontDependent.join(", ")}`,
    );
  }
  if (coverage.uncoveredKeys.length) {
    problems.push(
      `default keymap entries no catalog case exercises: ${coverage.uncoveredKeys.join(", ")}`,
    );
  }
  if (coverage.uncoveredEx.length) {
    problems.push(`ex commands no catalog case runs: ${coverage.uncoveredEx.join(", ")}`);
  }
  if (coverage.staleExclusions.length) {
    problems.push(`coverage exclusions that match nothing: ${coverage.staleExclusions.join(", ")}`);
  }
  return problems;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const started = performance.now();
  const browser = await launchChromium();
  let generated: Generated;
  try {
    generated = await generateVectors(browser);
  } finally {
    await browser.close();
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const problems = coverageProblems(generated);
  const { upstream } = generated;
  console.log(
    `${generated.vectors.length} vectors in ${seconds}s: ${generated.catalogCases} catalog cases ` +
      `(keymap entries covered: ${generated.coverage.coveredKeys}, ex commands: ${generated.coverage.coveredEx}, ` +
      `${generated.throwingCases} verified to throw), ${upstream.recorded} recorded upstream tests ` +
      `(${upstream.skipped.length} not recorded)`,
  );
  if (process.argv.includes("--verbose")) {
    for (const { test, reason } of upstream.skipped)
      console.log(`  not recorded: ${test}: ${reason}`);
  }
  if (check) {
    const committed = existsSync(VECTORS_PATH) ? readFileSync(VECTORS_PATH, "utf8") : "";
    const diff = committed === generated.text ? [] : summarizeDiff(committed, generated);
    if (committed !== generated.text && diff.length === 0)
      diff.push("vectors.jsonl differs byte-wise");
    if (diff.length > 0) {
      console.error(
        ["vectors.jsonl is stale; run `pnpm vim:vectors` and review the diff:", ...diff].join("\n"),
      );
    }
    for (const problem of problems) console.error(problem);
    if (diff.length > 0 || problems.length > 0) process.exitCode = 1;
    return;
  }
  // A case that threw is missing from `generated.text`; writing would silently drop it.
  if (generated.errors.length === 0) {
    writeFileSync(VECTORS_PATH, generated.text);
    console.log(`wrote ${VECTORS_PATH}`);
  } else {
    console.error(`not writing ${VECTORS_PATH}: ${generated.errors.length} case(s) threw`);
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
