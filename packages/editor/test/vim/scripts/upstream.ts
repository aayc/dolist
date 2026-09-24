/**
 * vim.js's own test suite in Chromium: against plain CodeMirror 6 (upstream's CM6 setup) and
 * against the Daily Do List editor, compared with the expected-failure lists.
 */
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright-core";
import { WEB_EXPECTED_FAILURES } from "../upstream/expected-failures";
import type { UpstreamResult } from "../upstream/runner";
import { launchChromium, openScriptPage } from "./browser";
import { bundlePage } from "./bundle";

export interface SuiteReport {
  label: string;
  results: UpstreamResult[];
  /** Upstream tests allowed to fail against this editor, with the reason. */
  expected: Readonly<Record<string, string>>;
  problems: string[];
}

function summarize(
  label: string,
  results: UpstreamResult[],
  expected: Readonly<Record<string, string>>,
): SuiteReport {
  const problems: string[] = [];
  for (const result of results) {
    const reason = expected[result.name];
    if (result.status === "fail" && reason === undefined) {
      problems.push(`${label}: ${result.name} failed: ${result.error}`);
    } else if (result.status === "pass" && reason !== undefined) {
      problems.push(`${label}: ${result.name} passes now; remove it from the expected failures`);
    }
  }
  const names = new Set(results.map((r) => r.name));
  for (const name of Object.keys(expected)) {
    if (!names.has(name))
      problems.push(`${label}: expected failure ${name} is not an upstream test`);
  }
  return { label, results, expected, problems };
}

export async function runPlainSuite(browser: Browser): Promise<SuiteReport> {
  const page = await openScriptPage(browser, await bundlePage("upstream-plain.ts"));
  try {
    const results = await page.evaluate(() => window.__vimUpstream.run());
    return summarize("upstream suite (plain CodeMirror)", results, {});
  } finally {
    await page.close();
  }
}

export async function runWebSuite(browser: Browser): Promise<SuiteReport> {
  const page = await openScriptPage(browser, await bundlePage("web.ts"));
  try {
    const results = await page.evaluate(() => window.__vimWeb.runUpstream());
    return summarize("upstream suite (Daily Do List editor)", results, WEB_EXPECTED_FAILURES);
  } finally {
    await page.close();
  }
}

export function describeSuite(report: SuiteReport): string {
  const count = (status: UpstreamResult["status"]) =>
    report.results.filter((r) => r.status === status).length;
  const failures = report.results.filter((r) => r.status === "fail");
  const expected = failures.filter((r) => report.expected[r.name] !== undefined).length;
  const listed = expected > 0 ? `, ${expected} expected failures` : "";
  return `${report.label}: ${count("pass")} passed, ${failures.length - expected} failed${listed}, ${count("skip")} skipped`;
}

async function main(): Promise<void> {
  const which = process.argv.includes("--web")
    ? "web"
    : process.argv.includes("--plain")
      ? "plain"
      : "both";
  const browser = await launchChromium();
  try {
    const reports: SuiteReport[] = [];
    if (which !== "web") reports.push(await runPlainSuite(browser));
    if (which !== "plain") reports.push(await runWebSuite(browser));
    for (const report of reports) {
      console.log(describeSuite(report));
      for (const problem of report.problems) console.error(`  ${problem}`);
      if (report.problems.length > 0) process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
