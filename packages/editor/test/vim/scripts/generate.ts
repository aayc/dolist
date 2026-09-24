/**
 * Runs the catalog (and recorded upstream scenarios) through the Chromium oracle and returns the
 * vectors file content, with coverage and statistics.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { type CoverageReport, checkCoverage } from "../catalog/coverage";
import { buildCatalog } from "../catalog/index";
import {
  type CaseSpec,
  createHeader,
  type ExpectedState,
  serializeVectors,
  type VectorCase,
} from "../format";
import type { OracleApi, OracleRun } from "../pages/oracle";
import type { RecordRun } from "../pages/upstream-record";
import { openScriptPage } from "./browser";
import { bundlePage } from "./bundle";

const require = createRequire(import.meta.url);

function packageVersion(entry: string): string {
  const main = require.resolve(entry);
  for (let dir = dirname(main); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === entry && pkg.version) return pkg.version;
    } catch {
      // Keep walking up.
    }
  }
  throw new Error(`can't find the package.json of ${entry}`);
}

export function engineDescription(): string {
  const adapter = packageVersion("@replit/codemirror-vim");
  const core = packageVersion("@replit/codemirror-vim-core");
  return `@replit/codemirror-vim@${adapter} (@replit/codemirror-vim-core@${core})`;
}

const CHUNK = 400;

export interface UpstreamStats {
  recorded: number;
  skipped: Array<{ test: string; reason: string }>;
}

export interface Generated {
  text: string;
  vectors: VectorCase[];
  coverage: CoverageReport;
  errors: Array<{ name: string; error: string }>;
  catalogCases: number;
  throwingCases: number;
  upstream: UpstreamStats;
}

/** Records upstream tests in a page of their own (they leave global engine state behind). */
async function recordUpstream(browser: Browser): Promise<RecordRun> {
  const page = await openScriptPage(browser, await bundlePage("upstream-record.ts"));
  try {
    return await page.evaluate(() => window.__vimRecord.run());
  } finally {
    await page.close();
  }
}

function firstDifference(expected: ExpectedState[], actual: VectorCase): string | null {
  for (let i = 0; i < expected.length; i++) {
    const observed = JSON.stringify(expected[i]);
    const replayed = JSON.stringify(actual.steps[i]?.expect);
    if (observed !== replayed) return `step ${i + 1}: observed ${observed}, replayed ${replayed}`;
  }
  return null;
}

async function runChunked(page: Page, cases: readonly CaseSpec[]): Promise<OracleRun> {
  const total: OracleRun = { vectors: [], coverage: [], errors: [] };
  for (let i = 0; i < cases.length; i += CHUNK) {
    const run = await page.evaluate(
      (chunk) => (window as unknown as { __vimOracle: OracleApi }).__vimOracle.runCases(chunk),
      cases.slice(i, i + CHUNK),
    );
    total.vectors.push(...run.vectors);
    total.coverage.push(...run.coverage);
    total.errors.push(...run.errors);
  }
  return total;
}

export async function generateVectors(browser: Browser): Promise<Generated> {
  const catalog = buildCatalog();
  const recorded = await recordUpstream(browser);
  const page = await openScriptPage(
    browser,
    await bundlePage("oracle.ts", { instrumentVim: true }),
  );
  try {
    const tables = await page.evaluate(() => window.__vimOracle.engineTables());
    const run = await runChunked(page, catalog.cases);
    const errors = [...run.errors];
    const throwing = await runChunked(
      page,
      catalog.throwing.map((c) => c.spec),
    );
    for (const vector of throwing.vectors) {
      errors.push({
        name: vector.name,
        error: "expected vim.js to throw (catalog `throws`), but it didn't: record it as a vector",
      });
    }

    const upstream: UpstreamStats = { recorded: 0, skipped: [...recorded.skipped] };
    const replays = await runChunked(
      page,
      recorded.recordings.map((r) => r.spec),
    );
    const replayed = new Map(replays.vectors.map((v) => [v.name, v]));
    const vectors = [...run.vectors];
    for (const recording of recorded.recordings) {
      const vector = replayed.get(recording.spec.name);
      const failure = replays.errors.find((e) => e.name === recording.spec.name);
      const difference = vector ? firstDifference(recording.observed, vector) : null;
      if (!vector || difference) {
        upstream.skipped.push({
          test: recording.test,
          reason: vector
            ? `replay diverges from the recorded run (${difference})`
            : `replay throws: ${failure?.error.split("\n")[0]}`,
        });
        continue;
      }
      vectors.push(vector);
      upstream.recorded++;
    }

    if (page.errors.length > 0)
      errors.push(...page.errors.map((error) => ({ name: "(page)", error })));
    return {
      text: serializeVectors(createHeader(engineDescription()), vectors),
      vectors,
      coverage: checkCoverage(tables, run.coverage),
      errors,
      catalogCases: catalog.cases.length,
      throwingCases: catalog.throwing.length,
      upstream,
    };
  } finally {
    await page.close();
  }
}
