/**
 * The crash-safety and exact-bytes assumptions of the persistence layer, on a real file system:
 * LocalFs writes atomically, and quarantine moves files with `rename`, so even bytes the text API
 * cannot represent (invalid UTF-8 in a truncated file) survive untouched.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFsStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRecords } from "../../src/orchestrator/records";
import { createThreadStore, threadJournalPath } from "../../src/threads/store";
import { NOW, readFixture, STAMP } from "./helpers";

let root: string | undefined;
let storage: LocalFsStorageProvider | undefined;

afterEach(async () => {
  await storage?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  storage = undefined;
});

async function localVault(): Promise<{ root: string; storage: LocalFsStorageProvider }> {
  root = await mkdtemp(join(tmpdir(), "ddl-persist-"));
  storage = new LocalFsStorageProvider({ root });
  await storage.init();
  return { root, storage };
}

describe("persistence on the local file system", () => {
  it("advertises atomic writes (the store relies on them instead of its own temp files)", async () => {
    const { storage } = await localVault();
    expect(storage.capabilities.atomicWrites).toBe(true);
  });

  it("moves a corrupt file aside byte for byte, invalid UTF-8 included", async () => {
    const { root, storage } = await localVault();
    const bytes = Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0xc3]);
    await mkdir(join(root, ".daily-do-list", "state"), { recursive: true });
    await writeFile(join(root, ".daily-do-list", "state", "records.json"), bytes);
    const records = new TaskRecords({ storage, now: () => NOW });
    await records.load();
    const moved = await readFile(
      join(root, ".daily-do-list", "corrupt", "state", `records.${STAMP}.json`),
    );
    expect(moved.equals(bytes)).toBe(true);
    expect(await readdir(join(root, ".daily-do-list", "state"))).toEqual([]);
  });

  it("moves a snapshot into its journal, conditionally removing it", async () => {
    const { root, storage } = await localVault();
    await mkdir(join(root, ".daily-do-list", "threads"), { recursive: true });
    await writeFile(
      join(root, ".daily-do-list", "threads", "thr_minimal0001.json"),
      readFixture("threads", "v1-minimal.json"),
    );
    const store = createThreadStore({ storage, now: () => NOW });
    await store.load();
    expect(store.get("thr_minimal0001")).toMatchObject({ id: "thr_minimal0001", title: "" });
    expect(await readdir(join(root, ".daily-do-list", "threads"))).toEqual([]);
    expect(await readdir(join(root, ".daily-do-list", "state", "journal", "threads"))).toEqual([
      "thr_minimal0001.jsonl",
    ]);
  });

  it("appends to thread journals and leaves no temp files behind", async () => {
    const { root, storage } = await localVault();
    const store = createThreadStore({ storage, now: () => NOW });
    const thread = store.create({
      taskId: "tsk_1",
      notePath: "Daily/2026-09-23.md",
      title: "Réserver 🦷",
    });
    store.upsertMessage(thread.id, {
      id: "m1",
      kind: "text",
      role: "agent",
      author: "orchestrator",
      createdAt: NOW,
      text: "lone surrogate \ud800 and emoji 🦷",
    });
    await store.flush();
    expect(await readdir(join(root, ".daily-do-list", "state", "journal", "threads"))).toEqual([
      `${thread.id}.jsonl`,
    ]);
    expect(await readdir(join(root, ".daily-do-list"))).toEqual(["state"]);
    const reloaded = createThreadStore({ storage, now: () => NOW });
    await reloaded.load();
    expect(reloaded.get(thread.id)).toEqual(store.get(thread.id));
    expect(await readFile(join(root, threadJournalPath(thread.id)), "utf8")).toContain("🦷");
  });
});
