import { chmod, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObsidianImportJob } from "@ddl/core";
import { afterEach, describe, expect, it } from "vitest";
import { ObsidianImporter } from "./importer";
import {
  currentSettings,
  makeTestbed,
  OBSIDIAN_FILES,
  snapshotTree,
  type Testbed,
  TODAY,
} from "./test-vaults";

let bed: Testbed;

async function setup(): Promise<ObsidianImporter> {
  bed = await makeTestbed();
  return new ObsidianImporter({
    places: { home: bed.home, vault: bed.vault, homedir: bed.dir },
    settings: () => currentSettings(),
    now: () => TODAY,
  });
}

/** Cancels the import the first time it reaches `phase`. */
function cancelOnce(importer: ObsidianImporter, phase: ObsidianImportJob["phase"]) {
  let done = false;
  return importer.onProgress((job) => {
    if (done || job.state !== "running" || job.phase !== phase) return;
    done = true;
    void importer.cancel();
  });
}

/** Everything in the testbed folder: the vaults, home, and whatever an import left there. */
async function testbedEntries(): Promise<string[]> {
  return (await readdir(bed.dir)).sort();
}

afterEach(async () => {
  await chmod(join(bed.vault, "Notes/Groceries.md"), 0o644).catch(() => undefined);
  await bed?.cleanup();
});

describe("import progress", () => {
  it("reports every phase in order, then the outcome", async () => {
    const importer = await setup();
    const events: ObsidianImportJob[] = [];
    importer.onProgress((job) => events.push(job));
    await importer.startImport({ source: bed.source });
    await importer.settled();

    const phases = events.map((event) => event.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(["checking", "copying", "carrying_over", "finishing"]);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ state: "done", finishedAt: TODAY.getTime() });
    expect(last.result?.copied.files).toBe(Object.keys(OBSIDIAN_FILES).length);
    expect(last.progress.files).toBe(last.progress.totalFiles);
    expect(last.progress.bytes).toBe(last.progress.totalBytes);
    expect(last.progress.totalFiles).toBe(Object.keys(OBSIDIAN_FILES).length + 9);
    expect(events.every((event) => event.state === "running" || event === last)).toBe(true);
  });

  it("hands listeners snapshots they can keep", async () => {
    const importer = await setup();
    const events: ObsidianImportJob[] = [];
    importer.onProgress((job) => events.push(job));
    await importer.startImport({ source: bed.source });
    await importer.settled();
    expect(events[0]).toMatchObject({ state: "running", phase: "checking" });
    expect(importer.status()).toEqual(events.at(-1));
  });

  it("stops telling a listener once it unsubscribed", async () => {
    const importer = await setup();
    const events: ObsidianImportJob[] = [];
    const unsubscribe = importer.onProgress((job) => events.push(job));
    unsubscribe();
    await importer.startImport({ source: bed.source });
    await importer.settled();
    expect(events).toEqual([]);
  });
});

describe("cancelling an import", () => {
  it("stops it and removes everything it wrote", async () => {
    const importer = await setup();
    const before = await testbedEntries();
    const trees = [await snapshotTree(bed.source), await snapshotTree(bed.vault)];
    let cancelled: Promise<ObsidianImportJob> | undefined;
    importer.onProgress((job) => {
      if (job.phase === "copying" && !cancelled) cancelled = importer.cancel();
    });
    await importer.startImport({ source: bed.source });
    await importer.settled();
    const job = await cancelled!;
    expect(job).toMatchObject({ state: "cancelled", phase: "copying" });
    expect(job.result).toBeUndefined();
    expect(importer.status()).toMatchObject({ id: job.id, state: "cancelled" });
    expect(await testbedEntries()).toEqual(before);
    expect([await snapshotTree(bed.source), await snapshotTree(bed.vault)]).toEqual(trees);
  });

  it("keeps an empty destination folder the user made, still empty", async () => {
    const importer = await setup();
    const destination = join(bed.dir, "New vault");
    await mkdir(destination);
    cancelOnce(importer, "carrying_over");
    await importer.startImport({ source: bed.source, destination });
    await importer.settled();
    expect(importer.status()?.state).toBe("cancelled");
    expect(await readdir(destination)).toEqual([]);
  });

  it("answers 404 when nothing runs, and a cancelled import can run again", async () => {
    const importer = await setup();
    await expect(importer.cancel()).rejects.toMatchObject({ status: 404, code: "not_found" });
    const stop = cancelOnce(importer, "copying");
    await importer.startImport({ source: bed.source });
    await importer.settled();
    stop();
    await importer.startImport({ source: bed.source });
    await importer.settled();
    const job = importer.status()!;
    expect(job.state).toBe("done");
    expect(await readFile(join(job.destination, "Ideas.md"), "utf8")).toBe(
      OBSIDIAN_FILES["Ideas.md"],
    );
  });

  it("is what closing the importer does to a running import", async () => {
    const importer = await setup();
    const before = await testbedEntries();
    await importer.startImport({ source: bed.source });
    await importer.close();
    expect(importer.status()?.state).toBe("cancelled");
    expect(await testbedEntries()).toEqual(before);
  });
});

describe("a failed import", () => {
  it("says why and leaves nothing behind", async () => {
    const importer = await setup();
    const before = await testbedEntries();
    await chmod(join(bed.vault, "Notes/Groceries.md"), 0o000);
    await importer.startImport({ source: bed.source });
    await importer.settled();
    expect(importer.status()).toMatchObject({
      state: "failed",
      phase: "carrying_over",
      error: "Notes/Groceries.md in the current vault can't be read",
    });
    expect(await testbedEntries()).toEqual(before);
  });
});
