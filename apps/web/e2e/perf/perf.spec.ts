import { writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { badge, dailyPath, noteTitle, type PerfMeasure } from "../helpers";

/**
 * Performance budgets (mock mode). CI runs with PERF_BUDGET_MULTIPLIER=2 to absorb slower shared
 * runners; locally the raw budgets apply. Results are written to apps/web/perf-results.json.
 */
const MULTIPLIER = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1") || 1;
const BUDGET_MS = {
  appInteractive: 800,
  dailyOpenCached: 50,
  dailyOpenUncached: 150,
  tabSwitch: 30,
  threadOpen: 100,
  keystrokeP95: 16,
  longTaskMs: 50,
};
const BIG_NOTE = "Perf/Big note.md";

/** Shape read by .github/scripts/perf-summary.mjs (one row per metric). */
interface MetricResult {
  name: string;
  /** The statistic compared against the budget (see `stat`). */
  value: number;
  unit: "ms" | "count";
  budget: number;
  passed: boolean;
  stat: "median" | "p95" | "max" | "count";
  median: number;
  p95: number;
  max: number;
  n: number;
}

const results: MetricResult[] = [];
const samplesByMetric: Record<string, number[]> = {};

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!;
}

function record(name: string, samples: number[], budget: number, stat: MetricResult["stat"]) {
  const rounded = samples.map((v) => Math.round(v * 10) / 10);
  const median = rounded.length ? percentile(rounded, 50) : 0;
  const p95 = rounded.length ? percentile(rounded, 95) : 0;
  const max = rounded.length ? Math.max(...rounded) : 0;
  const value =
    stat === "median" ? median : stat === "p95" ? p95 : stat === "max" ? max : samples.length;
  // The count budget is absolute (zero long tasks), never scaled.
  const limit = stat === "count" ? budget : budget * MULTIPLIER;
  const unit = stat === "count" ? "count" : "ms";
  const result: MetricResult = {
    name,
    value,
    unit,
    budget: limit,
    passed: value <= limit,
    stat,
    median,
    p95,
    max,
    n: samples.length,
  };
  results.push(result);
  samplesByMetric[name] = rounded;
  const suffix = unit === "ms" ? "ms" : "";
  console.log(
    `[perf] ${name}: ${stat}=${value}${suffix} (budget ${limit}${suffix}) median=${median} p95=${p95} max=${max} n=${samples.length}`,
  );
  return result;
}

function bigNote(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    if (i % 10 === 0) out.push(`## Section ${i / 10}`);
    else if (i % 3 === 0) out.push(`  - note line ${i} with some context about the task above`);
    else
      out.push(`- [${i % 4 === 0 ? "x" : " "}] Task number ${i}: follow up with vendor ${i % 17}`);
  }
  return out.join("\n");
}

async function boot(page: Page, query = ""): Promise<number> {
  await page.goto(`/?mock=1&perf=1${query}`);
  await page.waitForFunction(() =>
    window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
  );
  return page.evaluate(
    () => window.__ddlPerf!.measures.find((m) => m.name === "app:interactive")!.duration,
  );
}

async function waitForPrefetch(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__ddlPerf?.prefetched === true);
}

async function measure(
  page: Page,
  name: string,
  action: () => Promise<void>,
): Promise<PerfMeasure> {
  const count = () =>
    page.evaluate((n) => window.__ddlPerf!.measures.filter((m) => m.name === n).length, name);
  const before = await count();
  await action();
  await page.waitForFunction(
    ([n, c]) => window.__ddlPerf!.measures.filter((m) => m.name === n).length > (c as number),
    [name, before] as const,
  );
  return page.evaluate((n) => {
    const list = window.__ddlPerf!.measures.filter((m) => m.name === n);
    return list[list.length - 1]!;
  }, name);
}

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  const summary = {
    generatedAt: new Date().toISOString(),
    multiplier: MULTIPLIER,
    browser: process.env.CI ? "chromium" : "chrome",
    results,
    samples: samplesByMetric,
  };
  writeFileSync(
    new URL("../../perf-results.json", import.meta.url),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
});

test("app:interactive (navigation start → today's note in the editor)", async ({ page }) => {
  const first = record(
    "app:interactive (first load)",
    [await boot(page)],
    BUDGET_MS.appInteractive,
    "max",
  );
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) samples.push(await boot(page));
  const warm = record("app:interactive", samples, BUDGET_MS.appInteractive, "median");
  expect(first.passed && warm.passed).toBe(true);
});

test("daily:open cached and uncached", async ({ page }) => {
  await boot(page);
  await waitForPrefetch(page);
  const cached: number[] = [];
  const uncached: number[] = [];
  for (let i = 0; i < 12; i++) {
    await page.evaluate(() => window.__ddlDebug!.openNote("Ideas.md"));
    await expect(noteTitle(page)).toHaveValue("Ideas");
    const evict = i % 3 === 2;
    if (evict) await page.evaluate((path) => window.__ddlDebug!.evictNote(path), dailyPath());
    const m = await measure(page, "daily:open", () => page.keyboard.press("ControlOrMeta+Shift+D"));
    (m.detail?.cached ? cached : uncached).push(m.duration);
  }
  const a = record("daily:open (cached)", cached, BUDGET_MS.dailyOpenCached, "p95");
  const b = record("daily:open (uncached)", uncached, BUDGET_MS.dailyOpenUncached, "p95");
  expect(uncached.length).toBeGreaterThan(0);
  expect(a.passed && b.passed).toBe(true);
});

test("daily:prev (Mod+Shift+P)", async ({ page }) => {
  await boot(page);
  await waitForPrefetch(page);
  const cached: number[] = [];
  const uncached: number[] = [];
  for (let i = 0; i < 10; i++) {
    if (i % 3 === 0)
      await page.evaluate((path) => window.__ddlDebug!.evictNote(path), dailyPath(-1));
    const m = await measure(page, "daily:prev", () => page.keyboard.press("ControlOrMeta+Shift+P"));
    (m.detail?.cached ? cached : uncached).push(m.duration);
    await page.keyboard.press("ControlOrMeta+Shift+D");
    await expect(page.getByTestId("tab")).toHaveAttribute("data-path", dailyPath());
  }
  const a = record("daily:prev (cached)", cached, BUDGET_MS.dailyOpenCached, "p95");
  const b = record("daily:prev (uncached)", uncached, BUDGET_MS.dailyOpenUncached, "p95");
  expect(a.passed && b.passed).toBe(true);
});

test("tab:switch between a 2000-line note and today's note", async ({ page }) => {
  await boot(page);
  await waitForPrefetch(page);
  await page.evaluate(
    ([path, content]) => window.__ddlMock!.createNote(path!, content!),
    [BIG_NOTE, bigNote(2000)],
  );
  await page.evaluate((path) => window.__ddlDebug!.openNote(path, true), BIG_NOTE);
  await expect(page.getByTestId("tab")).toHaveCount(2);
  // Let the freshly opened 2000-line note finish its first layout/idle work, then warm up once.
  await page.waitForTimeout(400);
  const tabs = page.getByTestId("tab");
  for (let i = 0; i < 2; i++) await measure(page, "tab:switch", () => tabs.nth(i % 2).click());
  const samples: number[] = [];
  for (let i = 0; i < 12; i++) {
    const target = tabs.nth(i % 2);
    const m = await measure(page, "tab:switch", () => target.click());
    samples.push(m.duration);
  }
  expect(record("tab:switch", samples, BUDGET_MS.tabSwitch, "p95").passed).toBe(true);
});

test("thread:open (badge click → thread rendered)", async ({ page }) => {
  await boot(page, "&mockSpeed=4");
  await waitForPrefetch(page);
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Research quiet dishwashers", { delay: 5 });
  await expect(badge(page)).toHaveClass(/cm-ddl-badge-(working|done)/, { timeout: 20_000 });
  const samples: number[] = [];
  for (let i = 0; i < 6; i++) {
    const m = await measure(page, "thread:open", () => badge(page).click());
    samples.push(m.duration);
    await expect(page.getByTestId("thread-view")).toBeVisible();
    await page.getByTestId("thread-close").click();
    await expect(page.getByTestId("right-panel")).toBeHidden();
  }
  expect(record("thread:open", samples, BUDGET_MS.threadOpen, "p95").passed).toBe(true);
});

test("vim mode: keystroke latency and long tasks in a 2000-line note", async ({ page }) => {
  await boot(page);
  await waitForPrefetch(page);
  await page.evaluate(
    ([path, content]) => window.__ddlMock!.createNote(path!, content!),
    [BIG_NOTE, bigNote(2000)],
  );
  await page.evaluate((path) => window.__ddlDebug!.openNote(path), BIG_NOTE);
  await expect(noteTitle(page)).toHaveValue("Big note");
  await page.evaluate(() => window.__ddlDebug!.runCommand("editor:vim"));
  await expect(page.getByTestId("status-vim")).toHaveAttribute("data-mode", "normal");
  await page.locator(".cm-content").click();
  await page.keyboard.type("Go", { delay: 25 });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__ddlPerf!.clear());

  // Insert mode: every key goes through vim's handler before CodeMirror inserts it.
  const text = "Ask the landlord whether the parking spot comes with the renewed lease ";
  for (let round = 0; round < 2; round++) {
    await page.keyboard.type(text, { delay: 25 });
    await page.keyboard.press("Enter");
  }
  // Normal mode: motions, edits and undo in the long note.
  await page.keyboard.press("Escape");
  for (let round = 0; round < 12; round++) await page.keyboard.type("kkwwbjjxu", { delay: 25 });
  await page.waitForTimeout(800);

  const { keystrokes, longTasks } = await page.evaluate(() => ({
    keystrokes: window
      .__ddlPerf!.measures.filter((m) => m.name === "keystroke")
      .map((m) => m.duration),
    longTasks: window.__ddlPerf!.longTasks.map((t) => t.duration),
  }));
  expect(keystrokes.length).toBeGreaterThan(250);
  const latency = record("keystroke (vim)", keystrokes, BUDGET_MS.keystrokeP95, "p95");
  const over = longTasks.filter((d) => d > BUDGET_MS.longTaskMs);
  const tasks = record("long tasks > 50ms while typing (vim)", over, 0, "count");
  expect(latency.passed).toBe(true);
  expect(tasks.passed, `long tasks: ${JSON.stringify(longTasks)}`).toBe(true);
});

test("keystroke latency and long tasks while typing in a 2000-line note", async ({ page }) => {
  await boot(page);
  await waitForPrefetch(page);
  await page.evaluate(
    ([path, content]) => window.__ddlMock!.createNote(path!, content!),
    [BIG_NOTE, bigNote(2000)],
  );
  await page.evaluate((path) => window.__ddlDebug!.openNote(path), BIG_NOTE);
  await expect(noteTitle(page)).toHaveValue("Big note");
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  // Let autosave / idle work from opening settle before sampling.
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__ddlPerf!.clear());

  const text =
    "Follow up with the landlord about the lease renewal and ask whether the parking spot is included ";
  for (let round = 0; round < 3; round++) {
    await page.keyboard.type(text, { delay: 25 });
    await page.keyboard.press("Enter");
  }
  // Include the trailing autosave + badge/word-count work in the long-task window.
  await page.waitForTimeout(800);

  const { keystrokes, longTasks } = await page.evaluate(() => ({
    keystrokes: window
      .__ddlPerf!.measures.filter((m) => m.name === "keystroke")
      .map((m) => m.duration),
    longTasks: window.__ddlPerf!.longTasks.map((t) => t.duration),
  }));
  expect(keystrokes.length).toBeGreaterThan(250);
  const latency = record("keystroke", keystrokes, BUDGET_MS.keystrokeP95, "p95");
  const over = longTasks.filter((d) => d > BUDGET_MS.longTaskMs);
  const tasks = record("long tasks > 50ms while typing", over, 0, "count");
  expect(latency.passed).toBe(true);
  expect(tasks.passed, `long tasks: ${JSON.stringify(longTasks)}`).toBe(true);
});
