import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { LocalFsStorageProvider } from "./local-fs";
import { searchVault } from "./search";
import { mergeText } from "./sync/diff3";

/**
 * Hot paths behind the daemon's tree/search endpoints and every sync run. Budgets are p99 ms, set
 * from local measurements (list ≈ 13, search ≈ 13, merge ≈ 0.3 on an M-series Mac) with 3–6x
 * headroom for CI runners; scale with BENCH_BUDGET_MULTIPLIER.
 */
const MULTIPLIER = Number(process.env.BENCH_BUDGET_MULTIPLIER ?? 1) || 1;
const BUDGET_MS = {
  list2k: 40 * MULTIPLIER,
  search2k: 40 * MULTIPLIER,
  merge2k: 2 * MULTIPLIER,
};

const NOTES = 2_000;

function note(i: number): string {
  const lines = [`# Note ${i}`, ""];
  for (let t = 0; t < 30; t++)
    lines.push(`- [${t % 3 === 0 ? "x" : " "}] task ${t} for project ${i % 37}`);
  return `${lines.join("\n")}\n`;
}

let dir: string;
let vault: LocalFsStorageProvider;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ddl-bench-"));
  const root = join(dir, "vault");
  for (let folder = 0; folder < 20; folder++) {
    await mkdir(join(root, `Folder ${folder}`), { recursive: true });
  }
  await Promise.all(
    Array.from({ length: NOTES }, (_, i) =>
      writeFile(join(root, `Folder ${i % 20}`, `note-${i}.md`), note(i)),
    ),
  );
  vault = new LocalFsStorageProvider({ root });
  // Warm the version memo and the search cache, as a running daemon would have.
  await vault.list();
  await searchVault(vault, "warm-up");
});

afterAll(async () => {
  await vault.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("LocalFsStorageProvider.list: 2k-note vault, warm", async ({ bench }) => {
  const result = await bench("LocalFsStorageProvider.list: 2k-note vault, warm", async () => {
    await vault.list();
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.list2k);
});

test("searchVault: 2k-note vault, warm", async ({ bench }) => {
  const result = await bench("searchVault: 2k-note vault, warm", async () => {
    await searchVault(vault, "project 36", { limit: 50 });
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.search2k);
});

const BASE = Array.from({ length: 2_000 }, (_, i) => `- [ ] task ${i}`).join("\n");
const OURS = BASE.replace("- [ ] task 10\n", "- [x] task 10\n").replace(
  "- [ ] task 900\n",
  "- [ ] task 900 (moved)\n- [ ] follow-up\n",
);
const THEIRS = BASE.replace("- [ ] task 1500\n", "- [x] task 1500\n").replace(
  "- [ ] task 1999",
  "- [ ] task 1999\n- [ ] from phone",
);

test("mergeText: 2k-line note, edits on both sides", async ({ bench }) => {
  const result = await bench("mergeText: 2k-line note, edits on both sides", () => {
    mergeText(BASE, OURS, THEIRS, { unionInsertions: true });
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.merge2k);
});
