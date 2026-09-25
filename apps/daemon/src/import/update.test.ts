import { lstat, mkdir, readdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePersistedImportManifest } from "@ddl/contract";
import type { ObsidianImportJob, ObsidianUpdateReport } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
} from "./test-vaults";

const MERGED = "Journal/Daily/2026/09/2026-09-24.md";
const EMPTY: ObsidianUpdateReport = {
  added: { count: 0, paths: [] },
  updated: { count: 0, paths: [] },
  restored: { count: 0, paths: [] },
  conflicts: { count: 0, items: [] },
  deletedInSource: { count: 0, paths: [] },
  unchanged: Object.keys(OBSIDIAN_FILES).length,
  skipped: { count: 0, items: [] },
};

let bed: Testbed;
/** The vault the import made, now the one this daemon opens. */
let vault: string;
let updater: ObsidianImporter;

function importer(places: { vault: string }): ObsidianImporter {
  return new ObsidianImporter({
    places: { home: bed.home, vault: places.vault, homedir: bed.dir },
    settings: () => currentSettings(),
    now: () => TODAY,
  });
}

async function update(): Promise<ObsidianImportJob> {
  await updater.startUpdate();
  await updater.settled();
  const job = updater.status()!;
  expect(job.state, job.error).toBe("done");
  return job;
}

/** Writes an Obsidian file as Obsidian would: new content, a new mtime. */
async function editSource(path: string, content: string): Promise<void> {
  await mkdir(join(bed.source, path, ".."), { recursive: true });
  await writeFile(join(bed.source, path), content);
}

async function editHere(path: string, content: string): Promise<void> {
  await writeFile(join(vault, path), content);
}

const readHere = (path: string) => readFile(join(vault, path), "utf8");

beforeEach(async () => {
  bed = await makeTestbed();
  const first = importer({ vault: bed.vault });
  await first.startImport({ source: bed.source });
  await first.settled();
  vault = first.status()!.destination;
  updater = importer({ vault });
});

afterEach(async () => {
  await bed.cleanup();
});

describe("updating from Obsidian", () => {
  it("does nothing when nothing changed, without rewriting a file", async () => {
    const before = await snapshotTree(vault);
    const job = await update();
    expect(job).toMatchObject({ kind: "update", source: bed.source, destination: vault });
    expect(job.update).toEqual(EMPTY);
    const after = await snapshotTree(vault);
    delete after[".daily-do-list/import/obsidian.json"];
    delete before[".daily-do-list/import/obsidian.json"];
    delete after[".daily-do-list/import/"];
    delete before[".daily-do-list/import/"];
    expect(after).toEqual(before);
  });

  it("replaces what changed there and not here", async () => {
    await editSource("Ideas.md", "# Ideas\n- A garden bench\n- A hammock\n");
    const job = await update();
    expect(job.update).toMatchObject({ updated: { count: 1, paths: ["Ideas.md"] } });
    expect(await readHere("Ideas.md")).toBe("# Ideas\n- A garden bench\n- A hammock\n");
  });

  it("keeps both when a file changed on both sides", async () => {
    await editSource("Projects/Roadmap.md", "# Roadmap\n- [ ] Ship it (from the phone)\n");
    await editHere("Projects/Roadmap.md", "# Roadmap\n- [x] Ship the prototype\n");
    const job = await update();
    expect(job.update?.conflicts).toEqual({
      count: 1,
      items: [{ from: "Projects/Roadmap.md", to: "Projects/Roadmap (Obsidian).md" }],
    });
    expect(await readHere("Projects/Roadmap.md")).toBe("# Roadmap\n- [x] Ship the prototype\n");
    expect(await readHere("Projects/Roadmap (Obsidian).md")).toBe(
      "# Roadmap\n- [ ] Ship it (from the phone)\n",
    );
  });

  it("counts a daily note merged at import as changed here", async () => {
    await editSource(MERGED, "# Thursday\n- [ ] Answer the landlord (again)\n");
    const job = await update();
    expect(job.update?.conflicts.items).toEqual([
      { from: MERGED, to: "Journal/Daily/2026/09/2026-09-24 (Obsidian).md" },
    ]);
    expect(await readHere(MERGED)).toContain("## From Daily Do List");
  });

  it("makes one conflict copy per new Obsidian version, not one per update", async () => {
    await editSource("Ideas.md", "v2\n");
    await editHere("Ideas.md", "mine\n");
    await update();
    expect((await update()).update?.conflicts.count).toBe(0);
    await editSource("Ideas.md", "v3, a longer one\n");
    expect((await update()).update?.conflicts.items).toEqual([
      { from: "Ideas.md", to: "Ideas (Obsidian 2).md" },
    ]);
    expect(await readHere("Ideas.md")).toBe("mine\n");
    expect(await readHere("Ideas (Obsidian).md")).toBe("v2\n");
    expect(await readHere("Ideas (Obsidian 2).md")).toBe("v3, a longer one\n");
  });

  it("copies new files, as a conflict copy when this vault has another file there", async () => {
    await editSource("Inbox/From the phone.md", "- [ ] Buy stamps\n");
    await editSource("Notes/Groceries.md", "- Bread\n");
    const job = await update();
    expect(job.update).toMatchObject({
      added: { count: 1, paths: ["Inbox/From the phone.md"] },
      conflicts: {
        count: 1,
        items: [{ from: "Notes/Groceries.md", to: "Notes/Groceries (Obsidian).md" }],
      },
    });
    expect(await readHere("Inbox/From the phone.md")).toBe("- [ ] Buy stamps\n");
    expect(await readHere("Notes/Groceries.md")).toBe("- [ ] Oat milk\n");
  });

  it("never deletes: a file deleted in Obsidian stays here", async () => {
    await rm(join(bed.source, "Projects/Café ☕/Idées d’été.md"));
    const job = await update();
    expect(job.update?.deletedInSource).toEqual({
      count: 1,
      paths: ["Projects/Café ☕/Idées d’été.md"],
    });
    expect(await readHere("Projects/Café ☕/Idées d’été.md")).toBe(
      OBSIDIAN_FILES["Projects/Café ☕/Idées d’été.md"],
    );
  });

  it("writes back a file deleted here only when it changed in Obsidian", async () => {
    await rm(join(vault, "Ideas.md"));
    await rm(join(vault, "Templates/Meeting.md"));
    await editSource("Ideas.md", "# Ideas, edited on the phone\n");
    const job = await update();
    expect(job.update?.restored).toEqual({ count: 1, paths: ["Ideas.md"] });
    expect(await readHere("Ideas.md")).toBe("# Ideas, edited on the phone\n");
    await expect(lstat(join(vault, "Templates/Meeting.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("takes a file touched without a change as unchanged, and remembers its new time", async () => {
    await utimes(join(bed.source, "Ideas.md"), new Date(T0 + 60_000), new Date(T0 + 60_000));
    expect((await update()).update).toEqual(EMPTY);
    const text = await readFile(join(vault, ".daily-do-list/import/obsidian.json"), "utf8");
    const manifest = decodePersistedImportManifest(text);
    expect(manifest.ok && manifest.value.files.get("Ideas.md")?.mtimeMs).toBe(T0 + 60_000);
    expect(manifest.ok && manifest.value.updatedAt).toBe(TODAY.getTime());
  });

  it("records what it copied in the manifest", async () => {
    await editSource("Ideas.md", "fresh\n");
    await update();
    const text = await readFile(join(vault, ".daily-do-list/import/obsidian.json"), "utf8");
    const manifest = decodePersistedImportManifest(text);
    expect(manifest.ok && manifest.value.files.get("Ideas.md")?.sha256).toBe(sha256("fresh\n"));
  });

  it("only reads the Obsidian vault", async () => {
    await editSource("Ideas.md", "fresh\n");
    await editHere("Projects/Roadmap.md", "mine\n");
    const before = await snapshotTree(bed.source);
    await update();
    expect(await snapshotTree(bed.source)).toEqual(before);
  });

  it("never writes through a link leading out of the vault", async () => {
    const outside = join(bed.dir, "outside");
    await mkdir(outside);
    await rename(join(vault, "Attachments"), join(bed.dir, "moved-attachments"));
    await link(vault, "Attachments", outside);
    await editSource("Attachments/new.png", "png");
    const job = await update();
    expect(job.update?.skipped.items).toEqual([
      { path: "Attachments/new.png", reason: "symlink_outside" },
    ]);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("when there's nothing to update from", () => {
  it("answers 404 for a vault that wasn't imported", async () => {
    await expect(importer({ vault: bed.vault }).startUpdate()).rejects.toMatchObject({
      status: 404,
      message: "This vault wasn't imported from Obsidian",
    });
  });

  it("answers 404 when the Obsidian vault moved", async () => {
    await rename(bed.source, join(bed.dir, "Moved"));
    await expect(updater.startUpdate()).rejects.toMatchObject({
      status: 404,
      message: `The Obsidian vault isn't at ${bed.source} any more`,
    });
  });

  it("refuses while an import runs", async () => {
    const busy = importer({ vault });
    await busy.startImport({ source: bed.source, destination: join(bed.dir, "Another") });
    await expect(busy.startUpdate()).rejects.toMatchObject({ status: 409, code: "conflict" });
    await busy.settled();
  });
});
