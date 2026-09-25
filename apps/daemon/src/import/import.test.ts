import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePersistedImportManifest } from "@ddl/contract";
import { type ObsidianImportJob, parseTasks, silentLogger } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsStore } from "../settings-store";
import { sha256 } from "./files";
import { ObsidianImporter } from "./importer";
import {
  CURRENT_SETTINGS_FILE,
  currentFiles,
  currentSettings,
  link,
  makeTestbed,
  OBSIDIAN_DAILY,
  OBSIDIAN_FILES,
  ROUTINE_PATH,
  snapshotTree,
  T0,
  type Testbed,
  TODAY,
  type VaultOptions,
} from "./test-vaults";

let bed: Testbed;
let counter = 0;
/** The one Obsidian note the current vault's daily note is appended to. */
const MERGED_NOTE = "Journal/Daily/2026/09/2026-09-24.md";
const SETTINGS_FILE = ".daily-do-list/settings.json";

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
      if (path === MERGED_NOTE) continue;
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
    expect(manifest.value).toMatchObject({
      source: bed.source,
      importedAt: TODAY.getTime(),
      previousVault: bed.vault,
    });
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

describe("carrying over the current vault", () => {
  it("moves daily notes to Obsidian's folder and format, byte for byte", async () => {
    const importer = await setup();
    const destination = destinationOf(await runImport(importer));
    const files = currentFiles();
    for (const date of ["2026-09-22", "2026-09-23"]) {
      const to = join(destination, `Journal/Daily/2026/09/${date}.md`);
      expect(await readFile(to, "utf8")).toBe(files[`Daily/${date}.md`]);
      expect((await lstat(to)).mtimeMs).toBe(T0);
    }
    await expect(lstat(join(destination, "Daily"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends a date in both under ## From Daily Do List, closing Obsidian's open code block", async () => {
    const importer = await setup();
    const destination = destinationOf(await runImport(importer));
    const merged = await readFile(join(destination, "Journal/Daily/2026/09/2026-09-24.md"), "utf8");
    expect(merged).toBe(
      `${OBSIDIAN_FILES["Journal/Daily/2026/09/2026-09-24.md"]}\`\`\`\n\n## From Daily Do List\n\n${currentFiles()["Daily/2026-09-24.md"]}`,
    );
    expect(parseTasks(merged).map((task) => task.text)).toEqual([
      "Water the plants",
      "Answer the landlord",
      "Book the dentist",
      "Draft the quarterly report",
    ]);
  });

  it("keeps everything else at its path, and both files when names collide", async () => {
    const importer = await setup();
    const destination = destinationOf(await runImport(importer));
    const files = currentFiles();
    for (const path of [
      ROUTINE_PATH,
      "Excalidraw/Flow.excalidraw.md",
      "Notes/Groceries.md",
      "Attachments/receipt.png",
      ".trash/Deleted note.md",
    ]) {
      expect(await readFile(join(destination, path)), path).toEqual(Buffer.from(files[path]!));
    }
    expect(await readFile(join(destination, "ideas (Daily Do List).md"), "utf8")).toBe(
      files["ideas.md"],
    );
    expect(await readFile(join(destination, "Ideas.md"), "utf8")).toBe(OBSIDIAN_FILES["Ideas.md"]);
    expect(await readFile(join(destination, "Excalidraw/Sketch.excalidraw.md"), "utf8")).toBe(
      OBSIDIAN_FILES["Excalidraw/Sketch.excalidraw.md"],
    );
  });

  it("leaves hidden folders behind: the new vault's .obsidian is Obsidian's", async () => {
    const importer = await setup();
    const destination = destinationOf(await runImport(importer));
    expect(await readFile(join(destination, ".obsidian/app.json"), "utf8")).toBe(
      OBSIDIAN_FILES[".obsidian/app.json"],
    );
  });

  it("leaves the current vault exactly as it was", async () => {
    const importer = await setup();
    const before = await snapshotTree(bed.vault);
    await runImport(importer);
    expect(await snapshotTree(bed.vault)).toEqual(before);
  });

  it("lists only Obsidian's files in the manifest, merged notes with their Obsidian hash", async () => {
    const importer = await setup();
    const job = await runImport(importer);
    const text = await readFile(join(destinationOf(job), job.result!.manifest), "utf8");
    const manifest = decodePersistedImportManifest(text);
    if (!manifest.ok) throw new Error("manifest unreadable");
    expect([...manifest.value.files.keys()].sort()).toEqual(Object.keys(OBSIDIAN_FILES).sort());
    expect(manifest.value.files.get("Journal/Daily/2026/09/2026-09-24.md")?.sha256).toBe(
      sha256(Buffer.from(OBSIDIAN_FILES["Journal/Daily/2026/09/2026-09-24.md"]!)),
    );
  });

  it("renames a colliding routine the Daily Do List way", async () => {
    const importer = await setup({
      obsidian: { files: { [ROUTINE_PATH]: "Obsidian's own note about mornings.\n" } },
    });
    const job = await runImport(importer);
    expect(job.result?.carryOver.collisions.items).toEqual([
      { from: ROUTINE_PATH, to: "Routines/Morning briefing (Daily Do List).md" },
      { from: "ideas.md", to: "ideas (Daily Do List).md" },
    ]);
    expect(
      await readFile(
        join(destinationOf(job), "Routines/Morning briefing (Daily Do List).md"),
        "utf8",
      ),
    ).toBe(currentFiles()[ROUTINE_PATH]);
  });
});

describe("the new vault's settings", () => {
  async function settingsOf(job: ObsidianImportJob): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(destinationOf(job), SETTINGS_FILE), "utf8"));
  }

  it("keep the agent's and take daily notes and the editor from Obsidian", async () => {
    const importer = await setup();
    const settings = await settingsOf(await runImport(importer));
    expect(settings).toEqual({
      version: 1,
      theme: "light",
      editor: {
        vimMode: true,
        fontSize: 18,
        livePreview: true,
        showLineNumbers: true,
        spellcheck: false,
        vimrc: OBSIDIAN_FILES[".obsidian.vimrc"],
      },
      dailyNotes: OBSIDIAN_DAILY,
      agent: CURRENT_SETTINGS_FILE.agent,
      futureFeature: { enabled: true },
    });
  });

  it("are what the daemon's settings store reads in the new vault", async () => {
    const importer = await setup();
    const job = await runImport(importer);
    const storage = new MemoryStorageProvider();
    await storage.write(
      SETTINGS_FILE,
      await readFile(join(destinationOf(job), SETTINGS_FILE), "utf8"),
    );
    const store = await createSettingsStore({ storage, logger: silentLogger });
    expect(store.get()).toMatchObject({
      theme: "light",
      dailyNotes: OBSIDIAN_DAILY,
      editor: { vimMode: true, fontSize: 18, showLineNumbers: true },
      agent: { model: "mock-model", actOnExistingTasks: false },
    });
  });

  it("take Obsidian's theme when this vault never chose one", async () => {
    const importer = await setup({ current: { files: { ".daily-do-list/settings.json": null } } });
    expect(await settingsOf(await runImport(importer))).toMatchObject({
      theme: "dark",
      dailyNotes: OBSIDIAN_DAILY,
      editor: { vimMode: true },
    });
  });

  it("are copied unchanged, with a warning, when a newer app wrote them", async () => {
    const newer = '{"version":2,"dailyNotes":{"folder":"Daily"}}\n';
    const importer = await setup({ current: { files: { ".daily-do-list/settings.json": newer } } });
    expect((await importer.preview(bed.source)).warnings).toContain(
      "This vault's settings were saved by a newer version of Daily Do List, so they're copied unchanged: check the daily-note settings after switching.",
    );
    const job = await runImport(importer);
    expect(await readFile(join(destinationOf(job), SETTINGS_FILE), "utf8")).toBe(newer);
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
