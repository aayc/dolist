import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { LocalFsStorageProvider } from "./local-fs";
import { searchVault } from "./search";
import { mergeText } from "./sync/diff3";
import { mergeJournals } from "./sync/journal-merge";

/**
 * Hot paths behind the daemon's tree/search endpoints, its start, every sync run and the agent's
 * journal. Budgets are p99 ms, set from local measurements (a walked list ≈ 13; the first list
 * after a restart ≈ 20 with the version cache, ≈ 150 without; search ≈ 3 while watching; merge ≈
 * 0.3; journal append ≈ 8 — mostly the flush, whatever the journal's length — and journal merge ≈
 * 20 on an M-series Mac) with 3–6x headroom for CI runners; scale with BENCH_BUDGET_MULTIPLIER.
 */
const MULTIPLIER = Number(process.env.BENCH_BUDGET_MULTIPLIER ?? 1) || 1;
const BUDGET_MS = {
  list2k: 40 * MULTIPLIER,
  restart2k: 70 * MULTIPLIER,
  search2k: 10 * MULTIPLIER,
  merge2k: 2 * MULTIPLIER,
  journalAppend: 50 * MULTIPLIER,
  journalMerge: 80 * MULTIPLIER,
};

const NOTES = 2_000;

function note(i: number): string {
  const lines = [`# Note ${i}`, ""];
  for (let t = 0; t < 30; t++)
    lines.push(`- [${t % 3 === 0 ? "x" : " "}] task ${t} for project ${i % 37}`);
  return `${lines.join("\n")}\n`;
}

let dir: string;
let root: string;
let versionCache: string;
let vault: LocalFsStorageProvider;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ddl-bench-"));
  root = join(dir, "vault");
  versionCache = join(dir, "versions.json");
  for (let folder = 0; folder < 20; folder++) {
    await mkdir(join(root, `Folder ${folder}`), { recursive: true });
  }
  await Promise.all(
    Array.from({ length: NOTES }, (_, i) =>
      writeFile(join(root, `Folder ${i % 20}`, `note-${i}.md`), note(i)),
    ),
  );
  // A previous run that saved its version memo.
  const previous = new LocalFsStorageProvider({ root, versionCache });
  await previous.list();
  await previous.dispose();
  // Warm the version memo and the search cache, and watch, as a running daemon does.
  vault = new LocalFsStorageProvider({ root });
  vault.watch(() => {});
  await vault.whenWatchReady();
  await searchVault(vault, "warm-up");
});

afterAll(async () => {
  await vault.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("LocalFsStorageProvider.list: 2k-note vault, warm, walked", async ({ bench }) => {
  const result = await bench(
    "LocalFsStorageProvider.list: 2k-note vault, warm, walked",
    async () => {
      await vault.list({ includeHidden: true });
    },
  ).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.list2k);
});

test("LocalFsStorageProvider.list: 2k-note vault, restarted with its version cache", async ({
  bench,
}) => {
  const name = "LocalFsStorageProvider.list: 2k-note vault, restarted with its version cache";
  const result = await bench(name, async () => {
    await new LocalFsStorageProvider({ root, versionCache }).list();
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.restart2k);
});

test("searchVault: 2k-note vault, warm, watched", async ({ bench }) => {
  const result = await bench("searchVault: 2k-note vault, warm, watched", async () => {
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

const JOURNAL = ".daily-do-list/state/journal/threads/thr_bench.jsonl";
const event = (id: string, seq: number, epoch = 0) =>
  `${JSON.stringify({ v: 1, id, epoch, seq, at: 1790154000000 + seq, type: "message", message: { id: `msg_${id}`, kind: "text", role: "agent", author: "subagent:researcher", createdAt: 1790154000000 + seq, text: `step ${seq}: ${"looked at another page ".repeat(8)}` } })}\n`;

test("LocalFsStorageProvider.append: one event to a 5k-event journal (flushed)", async ({
  bench,
}) => {
  await vault.write(
    JOURNAL,
    Array.from({ length: 5_000 }, (_, i) => event(`e${i}`, i + 1)).join(""),
  );
  let seq = 5_000;
  const result = await bench(
    "LocalFsStorageProvider.append: one event to a 5k-event journal (flushed)",
    async () => {
      seq++;
      await vault.append(JOURNAL, event(`e${seq}`, seq));
    },
  ).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.journalAppend);
});

const SHARED = Array.from({ length: 5_000 }, (_, i) => event(`s${i}`, i + 1)).join("");
const LAPTOP = SHARED + Array.from({ length: 50 }, (_, i) => event(`l${i}`, 5_001 + i)).join("");
const PHONE = SHARED + Array.from({ length: 50 }, (_, i) => event(`p${i}`, 1 + i, 1)).join("");

test("mergeJournals: 5k shared events, 50 new on each side", async ({ bench }) => {
  const result = await bench("mergeJournals: 5k shared events, 50 new on each side", () => {
    mergeJournals(LAPTOP, PHONE);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS.journalMerge);
});
