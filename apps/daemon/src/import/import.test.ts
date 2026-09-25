import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePersistedImportManifest } from "@ddl/contract";
import type { ObsidianImportJob } from "@ddl/core";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "./files";
import { ObsidianImporter } from "./importer";
import {
  currentSettings,
  link,
  makeTestbed,
  OBSIDIAN_FILES,
  snapshotTree,
  T0,
  type Testbed,
  TODAY,
  type VaultOptions,
} from "./test-vaults";

let bed: Testbed;
let counter = 0;

async function setup(options: { obsidian?: VaultOptions; current?: VaultOptions } = {}) {
  bed = await makeTestbed(options);
  return importerFor(bed);
}

function importerFor(testbed: Testbed, settings = currentSettings()) {
  return new ObsidianImporter({
    places: { home: testbed.home, vault: testbed.vault, homedir: testbed.dir },
    settings: () => settings,
    now: () => TODAY,
    idFactory: (prefix) => `${prefix}_${++counter}`,
  });
}

/** Runs an import to the end and returns the finished job. */
async function runImport(
  importer: ObsidianImporter,
  destination?: string,
): Promise<ObsidianImportJob> {
  await importer.startImport({ source: bed.source, ...(destination ? { destination } : {}) });
  await importer.settled();
  return importer.status()!;
}

function destinationOf(job: ObsidianImportJob): string {
  return job.destination;
}

afterEach(async () => {
  await bed?.cleanup();
});

describe("importing copies the Obsidian vault", () => {
  it("byte for byte, times kept, into a new folder next to the current vault", async () => {
    const importer = await setup();
    const before = await snapshotTree(bed.source);
    const started = await importer.startImport({ source: bed.source });
    expect(started).toMatchObject({
      kind: "import",
      state: "running",
      phase: "checking",
      source: bed.source,
      destination: join(bed.dir, "Obsidian Notebook (Daily Do List)"),
      startedAt: TODAY.getTime(),
    });
    await importer.settled();
    const job = importer.status()!;
    expect(job).toMatchObject({ id: started.id, state: "done", phase: "finishing" });
    const destination = destinationOf(job);
    for (const [path, content] of Object.entries(OBSIDIAN_FILES)) {
      expect(await readFile(join(destination, path)), path).toEqual(Buffer.from(content));
      expect((await lstat(join(destination, path))).mtimeMs, path).toBe(T0);
    }
    expect(await snapshotTree(bed.source)).toEqual(before);
    expect(job.result?.copied).toEqual({
      files: Object.keys(OBSIDIAN_FILES).length,
      bytes: Object.values(OBSIDIAN_FILES).reduce((sum, c) => sum + Buffer.byteLength(c), 0),
    });
    expect((await readdir(bed.dir)).sort()).toEqual([
      "DailyDoList",
      "Obsidian Notebook",
      "Obsidian Notebook (Daily Do List)",
      "home",
    ]);
  });

  it("writes a manifest with the source and a hash of every copied file", async () => {
    const importer = await setup();
    const job = await runImport(importer);
    expect(job.result?.manifest).toBe(".daily-do-list/import/obsidian.json");
    const text = await readFile(join(destinationOf(job), job.result!.manifest), "utf8");
    const manifest = decodePersistedImportManifest(text);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value).toMatchObject({ source: bed.source, importedAt: TODAY.getTime() });
    for (const [path, content] of Object.entries(OBSIDIAN_FILES)) {
      expect(manifest.value.files.get(path), path).toMatchObject({
        sha256: sha256(Buffer.from(content)),
        size: Buffer.byteLength(content),
        mtimeMs: T0,
      });
    }
  });

  it("keeps empty folders and never makes a copy executable", async () => {
    const importer = await setup();
    await mkdir(join(bed.source, "Empty/Inside"), { recursive: true });
    await writeFile(join(bed.source, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    const job = await runImport(importer);
    const destination = destinationOf(job);
    expect((await lstat(join(destination, "Empty/Inside"))).isDirectory()).toBe(true);
    expect((await lstat(join(destination, "run.sh"))).mode & 0o111).toBe(0);
  });

  it("copies files linked from inside the vault, never what links lead outside to", async () => {
    const importer = await setup();
    const outside = join(bed.dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "not for the vault\n");
    await link(bed.source, "Links/inside.md", join(bed.source, "Ideas.md"));
    await link(bed.source, "Links/outside.md", join(outside, "secret.md"));
    await link(bed.source, "Links/outside-folder", outside);
    const job = await runImport(importer);
    const destination = destinationOf(job);
    const inside = await lstat(join(destination, "Links/inside.md"));
    expect(inside.isFile()).toBe(true);
    expect(await readFile(join(destination, "Links/inside.md"), "utf8")).toBe(
      OBSIDIAN_FILES["Ideas.md"],
    );
    expect(await readdir(join(destination, "Links"))).toEqual(["inside.md"]);
    expect(job.result?.skipped.items).toEqual([
      { path: "Links/outside-folder", reason: "symlink_outside" },
      { path: "Links/outside.md", reason: "symlink_outside" },
    ]);
  });

  it("leaves the Obsidian vault's own .daily-do-list folder behind", async () => {
    const importer = await setup({
      obsidian: { files: { ".daily-do-list/threads/thr_stale.json": "{}" } },
    });
    const job = await runImport(importer);
    const threads = await readdir(join(destinationOf(job), ".daily-do-list/threads")).catch(
      () => [],
    );
    expect(threads).not.toContain("thr_stale.json");
    expect(job.result?.skipped.items).toContainEqual({ path: ".daily-do-list", reason: "sidecar" });
  });

  it("imports into an empty folder the user made (Finder's .DS_Store aside)", async () => {
    const importer = await setup();
    const destination = join(bed.dir, "New vault");
    await mkdir(destination);
    await writeFile(join(destination, ".DS_Store"), "finder");
    const job = await runImport(importer, destination);
    expect(job.state).toBe("done");
    expect(await readdir(destination)).not.toContain(".DS_Store");
    expect(await readFile(join(destination, "Ideas.md"), "utf8")).toBe(OBSIDIAN_FILES["Ideas.md"]);
  });
});

describe("where the new vault may go", () => {
  it.each([
    ["a relative path", () => "New vault", /must be an absolute path/],
    ["a folder that isn't empty", () => bed.vault, /current vault|isn't empty/],
    [
      "a folder inside the Obsidian vault",
      () => join(bed.source, "New"),
      /inside the Obsidian vault/,
    ],
    ["the Obsidian vault itself", () => bed.source, /inside the Obsidian vault/],
    ["a folder inside Daily Do List's folder", () => join(bed.home, "v"), /Daily Do List's own/],
    ["a folder inside the current vault", () => join(bed.vault, "v"), /inside the current vault/],
    ["an existing file", () => join(bed.dir, "file.txt"), /isn't a folder/],
    ["a folder in a missing one", () => join(bed.dir, "missing/v"), /doesn't exist/],
    ["a non-empty folder", () => join(bed.dir, "full"), /isn't empty/],
  ])("refuses %s", async (_name, destination, message) => {
    const importer = await setup();
    await writeFile(join(bed.dir, "file.txt"), "x");
    await mkdir(join(bed.dir, "full"));
    await writeFile(join(bed.dir, "full", "note.md"), "x");
    await expect(
      importer.startImport({ source: bed.source, destination: destination() }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
    expect(importer.status()).toBeNull();
  });

  it("refuses a second import while one runs", async () => {
    const importer = await setup();
    await importer.startImport({ source: bed.source });
    await expect(
      importer.startImport({ source: bed.source, destination: join(bed.dir, "Other") }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    await importer.settled();
  });
});
