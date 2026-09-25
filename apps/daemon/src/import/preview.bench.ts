import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ObsidianImporter } from "./importer";
import {
  buildCurrentVault,
  currentSettings,
  OBSIDIAN_DAILY,
  OBSIDIAN_FILES,
  PNG_BYTES,
  TODAY,
} from "./test-vaults";

/**
 * The import preview on a large Obsidian vault: 10,000 notes in 100 folders, 500 daily notes
 * (60 of them on dates the current vault also has), 100 attachments, canvases and drawings. The
 * preview reads no note except the few in the agent's watch window and the merged ones. Budget:
 * p99 ms from local measurements (≈ 250 on an M-series Mac) with headroom for CI; scaled by
 * BENCH_BUDGET_MULTIPLIER.
 */
const MULTIPLIER = Number(process.env.BENCH_BUDGET_MULTIPLIER ?? 1) || 1;
const BUDGET_MS = 1_500 * MULTIPLIER;
/** The report's lists are capped, so its size doesn't grow with the vault. */
const MAX_REPORT_BYTES = 256 * 1024;

const NOTES = 10_000;
const FOLDERS = 100;
const DAILY = 500;
const MERGED = 60;

let dir: string;
let importer: ObsidianImporter;
let source: string;

function note(i: number): string {
  const lines = [`# Note ${i}`, "", `Links to [[Note ${(i * 7) % NOTES}]].`, ""];
  for (let t = 0; t < 20; t++) lines.push(`- [${t % 3 === 0 ? "x" : " "}] task ${t} of note ${i}`);
  return `${lines.join("\n")}\n`;
}

function dateAt(offset: number): Date {
  return new Date(2026, 8, 25 - offset, 12);
}

async function writeAll(root: string, files: Array<[string, string | Buffer]>): Promise<void> {
  const folders = new Set(files.map(([path]) => join(root, path, "..")));
  for (const folder of folders) await mkdir(folder, { recursive: true });
  for (let i = 0; i < files.length; i += 200) {
    await Promise.all(
      files.slice(i, i + 200).map(([path, content]) => writeFile(join(root, path), content)),
    );
  }
}

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "ddl-import-bench-")));
  source = join(dir, "Big vault");
  const vault = join(dir, "DailyDoList");
  const files: Array<[string, string | Buffer]> = Object.entries(OBSIDIAN_FILES);
  for (let i = 0; i < NOTES; i++) files.push([`Folder ${i % FOLDERS}/Note ${i}.md`, note(i)]);
  for (let d = 0; d < DAILY; d++) {
    const date = dateAt(d - 3);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    files.push([`${OBSIDIAN_DAILY.folder}/${y}/${m}/${y}-${m}-${day}.md`, note(d)]);
  }
  for (let i = 0; i < 100; i++) files.push([`Attachments/image ${i}.png`, PNG_BYTES]);
  for (let i = 0; i < 10; i++) files.push([`Boards/Board ${i}.canvas`, "{}"]);
  for (let i = 0; i < 10; i++)
    files.push([`Excalidraw/Drawing ${i}.excalidraw.md`, "# Excalidraw Data\n"]);
  await writeAll(source, files);

  await buildCurrentVault(vault);
  const daily: Array<[string, string]> = [];
  for (let d = 0; d < MERGED; d++) {
    const iso = dateAt(d).toLocaleDateString("sv-SE");
    daily.push([`Daily/${iso}.md`, `- [ ] Daily Do List task for ${iso}\n`]);
  }
  await writeAll(vault, daily);

  const home = join(dir, "home");
  await mkdir(home);
  importer = new ObsidianImporter({
    places: { home, vault, homedir: dir },
    settings: () => currentSettings(),
    now: () => TODAY,
  });
  // The first walk warms the file system cache, as the preview a user runs twice would find it.
  await importer.preview(source);
}, 300_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("import preview: 10k-note Obsidian vault", async ({ bench }) => {
  const report = await importer.preview(source);
  expect(report.notes).toBeGreaterThanOrEqual(NOTES + DAILY);
  expect(report.carryOver.daily.merged).toBeGreaterThanOrEqual(MERGED - 5);
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(MAX_REPORT_BYTES);

  const result = await bench("import preview: 10k-note Obsidian vault", async () => {
    await importer.preview(source);
  }).run();
  expect(result.latency.p99).toBeLessThan(BUDGET_MS);
}, 300_000);
