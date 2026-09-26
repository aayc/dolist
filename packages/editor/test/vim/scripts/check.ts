/**
 * `pnpm vim:check`: everything CI verifies about vim mode, in one Chromium session:
 *   1. vectors.jsonl is what the pinned engine produces (and the catalog covers every command);
 *   2. vim.js's own suite passes against plain CodeMirror 6;
 *   3. it passes against the Daily Do List editor, except the listed deliberate differences;
 *   4. every vector replays identically against the Daily Do List editor, except listed skips.
 * The four run at once, on pools of pages (`VIM_PAGES`). The replay takes the committed file; when
 * that turns out stale, the generated vectors replay too, so the problems listed are theirs.
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

function timed<T>(work: Promise<T>): Promise<{ value: T; took: string }> {
  const started = performance.now();
  return work.then((value) => ({ value, took: seconds(started) }));
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const browser = await launchChromium();
  try {
    const committed = existsSync(VECTORS_PATH) ? readFileSync(VECTORS_PATH, "utf8") : "";
    const [generated, plain, web, committedReplay] = await Promise.all([
      timed(generateVectors(browser)),
      timed(runPlainSuite(browser)),
      timed(runWebSuite(browser)),
      timed(replayVectors(browser, committed)),
    ]);

    const fresh = generated.value;
    const stale = committed === fresh.text ? [] : summarizeDiff(committed, fresh);
    if (committed !== fresh.text && stale.length === 0)
      stale.push("vectors.jsonl differs byte-wise");
    console.log(
      `vectors: ${fresh.vectors.length} regenerated in ${generated.took}, ` +
        (stale.length === 0 ? "committed file is up to date" : "committed file is STALE"),
    );
    if (stale.length > 0) {
      failures.push(
        ["vectors.jsonl is stale; run `pnpm vim:vectors` and review the diff:", ...stale].join(
          "\n",
        ),
      );
    }
    failures.push(...coverageProblems(fresh));

    for (const suite of [plain, web]) {
      console.log(`${describeSuite(suite.value)} (${suite.took})`);
      failures.push(...suite.value.problems);
    }

    const replay =
      stale.length === 0 ? committedReplay : await timed(replayVectors(browser, fresh.text));
    console.log(
      `vector replay (Daily Do List editor): ${replay.value.passed}/${replay.value.total} identical, ` +
        `${replay.value.skipped} known editor differences (${replay.took})`,
    );
    failures.push(...replay.value.problems);
  } finally {
    await browser.close();
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  }
}

await main();
