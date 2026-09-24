import { expect, test } from "vitest";
import { resolveTaskAnchors } from "./anchors";
import { trackTasks } from "./task-tracker";
import { parseTasks } from "./tasks";

/**
 * Hot paths that run on every keystroke (client: anchor resolution) or every save (daemon: parse +
 * track). Budgets are p99 latency in ms, deliberately loose enough for CI runners; the numbers are
 * written to bench-results.json and checked by scripts/bench-check.mjs.
 */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const MULTIPLIER = Number(env?.BENCH_BUDGET_MULTIPLIER ?? 1) || 1;
const BUDGET_MS = {
  parse2k: 6 * MULTIPLIER,
  track2k: 12 * MULTIPLIER,
  anchors2k: 12 * MULTIPLIER,
};

function makeNote(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (i % 10 === 0) out.push(`## Section ${i / 10}`);
    else if (i % 3 === 0) out.push(`  - note line ${i} with some context about the task above`);
    else
      out.push(`- [${i % 4 === 0 ? "x" : " "}] Task number ${i}: follow up with vendor ${i % 17}`);
  }
  return out.join("\n");
}

const NOTE_2K = makeNote(2000);
const PARSED_2K = parseTasks(NOTE_2K);
const TRACKED_2K = trackTasks([], PARSED_2K, { now: 0 }).tasks;
const EDITED_2K = parseTasks(NOTE_2K.replace("Task number 500", "Task number 500 (edited)"));
const ANCHORS = TRACKED_2K.slice(0, 50).map((t) => ({ taskId: t.id, text: t.text, line: t.line }));

test("parseTasks: 2k-line note", async ({ bench }) => {
  const result = await bench("parseTasks: 2k-line note", () => {
    parseTasks(NOTE_2K);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.parse2k);
});

test("trackTasks: 2k-line note, one edited task", async ({ bench }) => {
  const result = await bench("trackTasks: 2k-line note, one edited task", () => {
    trackTasks(TRACKED_2K, EDITED_2K, { now: 1 });
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.track2k);
});

test("resolveTaskAnchors: 50 anchors in a 2k-line note", async ({ bench }) => {
  const result = await bench("resolveTaskAnchors: 50 anchors in a 2k-line note", () => {
    resolveTaskAnchors(EDITED_2K, ANCHORS);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.anchors2k);
});
