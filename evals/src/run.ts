/**
 * Eval runner: `pnpm eval` (live model) or `pnpm eval:mock` (deterministic, used in CI).
 *   --suite <name>   run one suite       --filter <text>  only case ids containing text
 *   --concurrency N  parallel cases      --json <path>    write results (default eval-results/)
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvFiles } from "./env";
import type { EvalMode, EvalSuite, EvalSuiteResult } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
loadEnvFiles();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function loadSuites(): Promise<EvalSuite[]> {
  const dir = join(here, "suites");
  const files = (await readdir(dir).catch(() => [])).filter(
    (f) => /\.ts$/.test(f) && !f.endsWith(".test.ts"),
  );
  const suites: EvalSuite[] = [];
  for (const file of files.sort()) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: EvalSuite };
    if (mod.default) suites.push(mod.default);
  }
  return suites;
}

function formatMetrics(metrics: Record<string, number>): string {
  return Object.entries(metrics)
    .map(([k, v]) => `${k}=${Number.isInteger(v) ? v : v.toFixed(3)}`)
    .join("  ");
}

async function main() {
  const mode: EvalMode = process.argv.includes("--mock") ? "mock" : "live";
  const only = arg("suite");
  const filter = arg("filter");
  const concurrency = Number(arg("concurrency") ?? (mode === "live" ? 6 : 16));
  const suites = (await loadSuites()).filter((s) => !only || s.name === only);
  if (suites.length === 0) {
    console.log("No eval suites found.");
    return;
  }
  if (mode === "live" && !process.env.OPENROUTER_API_KEY) {
    console.error(
      "OPENROUTER_API_KEY is not set (put it in ~/.daily-do-list/.env or the environment).",
    );
    process.exit(2);
  }

  const results: EvalSuiteResult[] = [];
  for (const suite of suites) {
    const started = performance.now();
    const result = await suite.run({ mode, concurrency, ...(filter ? { filter } : {}) });
    results.push(result);
    const failed = result.cases.filter((c) => !c.passed);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `${result.passed ? "PASS" : "FAIL"} ${suite.name} [${mode}] ${result.cases.length - failed.length}/${result.cases.length} in ${secs}s  ${formatMetrics(result.metrics)}`,
    );
    for (const c of failed.slice(0, 15)) {
      console.log(
        `   ${c.critical ? "!!" : "  "} ${c.id}: expected ${JSON.stringify(c.expected)} got ${JSON.stringify(c.actual)}${c.notes ? ` — ${c.notes}` : ""}`,
      );
    }
  }

  const out = arg("json") ?? join(here, "..", "eval-results", `${mode}-${Date.now()}.json`);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ mode, results }, null, 2));
  console.log(`Results written to ${out}`);
  if (results.some((r) => !r.passed)) process.exitCode = 1;
}

await main();
