/**
 * The crash-safety and exact-bytes assumptions of the persistence layer, on a real file system:
 * LocalFs writes atomically, and quarantine moves files with `rename`, so even bytes the text API
 * cannot represent (invalid UTF-8 in a truncated file) survive untouched.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePersistedThread } from "@ddl/contract";
import { LocalFsStorageProvider } from "@ddl/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createThreadStore, threadPath } from "../../src/threads/store";
import { NOW, STAMP } from "./helpers";

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

  it("moves a corrupt thread aside byte for byte, invalid UTF-8 included", async () => {
    const { root, storage } = await localVault();
    const bytes = Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0xc3]);
    await mkdir(join(root, ".daily-do-list", "threads"), { recursive: true });
    await writeFile(join(root, ".daily-do-list", "threads", "thr_bad.json"), bytes);
    const store = createThreadStore({ storage, now: () => NOW });
    await store.load();
    expect(store.list()).toEqual([]);
    const moved = await readFile(
      join(root, ".daily-do-list", "corrupt", "threads", `thr_bad.${STAMP}.json`),
    );
    expect(moved.equals(bytes)).toBe(true);
    expect(await readdir(join(root, ".daily-do-list", "threads"))).toEqual([]);
  });

  it("writes valid thread files and leaves no temp files behind", async () => {
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
    expect(await readdir(join(root, ".daily-do-list", "threads"))).toEqual([`${thread.id}.json`]);
    const raw = await readFile(join(root, threadPath(thread.id)), "utf8");
    const decoded = decodePersistedThread(raw);
    expect(decoded.ok && decoded.value).toEqual(store.get(thread.id));
  });
});
