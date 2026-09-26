#!/usr/bin/env node
/**
 * Keeps in `.turbo/cache` only the entries this job's turbo runs used or wrote (the hashes in
 * `.turbo/runs/*.json`, written with TURBO_RUN_SUMMARY=true), so the cache a job saves holds its
 * current tasks instead of growing with every run it restored.
 *
 *   node .github/scripts/prune-turbo-cache.mjs [--cache .turbo/cache] [--runs .turbo/runs]
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const cacheDir = arg("--cache", ".turbo/cache");
const runsDir = arg("--runs", ".turbo/runs");

if (!existsSync(cacheDir)) {
  console.log(`prune-turbo-cache: no ${cacheDir}`);
  process.exit(0);
}
const summaries = existsSync(runsDir)
  ? readdirSync(runsDir).filter((file) => file.endsWith(".json"))
  : [];
if (summaries.length === 0) {
  // Without a record of what ran, keep everything rather than guess.
  console.log(`prune-turbo-cache: no run summaries in ${runsDir}; nothing pruned`);
  process.exit(0);
}

const used = new Set();
for (const file of summaries) {
  const summary = JSON.parse(readFileSync(join(runsDir, file), "utf8"));
  for (const task of summary.tasks ?? []) if (task.hash) used.add(task.hash);
}

let kept = 0;
let removed = 0;
for (const file of readdirSync(cacheDir)) {
  const hash = file.split(/[.-]/, 1)[0];
  if (used.has(hash)) kept++;
  else {
    rmSync(join(cacheDir, file), { recursive: true, force: true });
    removed++;
  }
}
console.log(`prune-turbo-cache: kept ${kept} file(s) of ${used.size} task(s), removed ${removed}`);
