/**
 * `pnpm vim:check`: everything CI verifies about vim mode, in one Chromium session:
 *   1. vectors.jsonl is what the pinned engine produces (and the catalog covers every command);
 *   2. vim.js's own suite passes against plain CodeMirror 6;
 *   3. it passes against the Daily Do List editor, except the listed deliberate differences;
 *   4. every vector replays identically against the Daily Do List editor, except listed skips.
 */
import { existsSync, readFileSync } from "node:fs";
import { launchChromium } from "./browser";
import { generateVectors } from "./generate";
import { replayVectors } from "./replay";
import { describeSuite, runPlainSuite, runWebSuite } from "./upstream";
import { coverageProblems, summarizeDiff, VECTORS_PATH } from "./vectors";

function seconds(since: number): string {
  return `${((performance.now() - since) / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const browser = await launchChromium();
  try {
    let started = performance.now();
    const generated = await generateVectors(browser);
    const committed = existsSync(VECTORS_PATH) ? readFileSync(VECTORS_PATH, "utf8") : "";
    const stale = committed === generated.text ? [] : summarizeDiff(committed, generated);
    if (committed !== generated.text && stale.length === 0)
      stale.push("vectors.jsonl differs byte-wise");
    console.log(
      `vectors: ${generated.vectors.length} regenerated in ${seconds(started)}, ` +
        (stale.length === 0 ? "committed file is up to date" : "committed file is STALE"),
    );
    if (stale.length > 0) {
      failures.push(
        ["vectors.jsonl is stale; run `pnpm vim:vectors` and review the diff:", ...stale].join(
          "\n",
        ),
      );
    }
    failures.push(...coverageProblems(generated));

    for (const run of [runPlainSuite, runWebSuite]) {
      started = performance.now();
      const report = await run(browser);
      console.log(`${describeSuite(report)} (${seconds(started)})`);
      failures.push(...report.problems);
    }

    started = performance.now();
    const replay = await replayVectors(browser, generated.text);
    console.log(
      `vector replay (Daily Do List editor): ${replay.passed}/${replay.total} identical, ` +
        `${replay.skipped} known editor differences (${seconds(started)})`,
    );
    failures.push(...replay.problems);
  } finally {
    await browser.close();
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  }
}

await main();
