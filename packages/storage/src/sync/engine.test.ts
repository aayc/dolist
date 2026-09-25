import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isAgentOwnedPath } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsStorageProvider } from "../local-fs";
import { MemoryStorageProvider } from "../memory";
import {
  ConflictError,
  StaleLeaseError,
  StorageError,
  type StorageProvider,
  type SyncStatus,
  type WriteOptions,
} from "../types";
import { SyncAbortedError, SyncEngine } from "./engine";
import { SYNC_STATE_DIR, snapshotPath } from "./snapshot";

interface Pair {
  primary: StorageProvider;
  target: StorageProvider;
  /** Changes a file in the target the way another app (or device) would. */
  externalTargetWrite(path: string, content: string): Promise<void>;
  /** Resolves once the target reports external changes (after the engine started watching). */
  targetWatchReady(): Promise<void>;
  cleanup(): Promise<void>;
}

const PAIRS: Array<[string, () => Promise<Pair>]> = [
  [
    "memory ↔ memory",
    async () => {
      const target = new MemoryStorageProvider({ id: "mirror" });
      return {
        primary: new MemoryStorageProvider({ id: "vault" }),
        target,
        externalTargetWrite: async (path, content) => target.simulateExternalChange(path, content),
        targetWatchReady: async () => {},
        cleanup: async () => {},
      };
    },
  ],
  [
    "local ↔ local",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "ddl-sync-"));
      const primary = new LocalFsStorageProvider({ root: join(dir, "vault") });
      const target = new LocalFsStorageProvider({ root: join(dir, "mirror") });
      return {
        primary,
        target,
        externalTargetWrite: async (path, content) => {
          const file = join(dir, "mirror", path);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, content);
        },
        targetWatchReady: () => target.whenWatchReady(),
        cleanup: async () => {
          await primary.dispose();
          await target.dispose();
          await rm(dir, { recursive: true, force: true });
        },
      };
    },
  ],
];

/** 2026-09-23 18:30 local time: conflict copies are stamped "2026-09-23 1830". */
const NOW = new Date(2026, 8, 23, 18, 30).getTime();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every synced file with its content (sync bookkeeping excluded). */
async function contents(provider: StorageProvider): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await provider.list({ includeHidden: true })) {
    if (entry.path.startsWith(`${SYNC_STATE_DIR}/`)) continue;
    out[entry.path] = (await provider.read(entry.path))?.content ?? "<missing>";
  }
  return out;
}

async function seed(provider: StorageProvider, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) await provider.write(path, content);
}

function emptyReport() {
  return { pushed: [], pulled: [], deletedLocal: [], deletedRemote: [], merged: [], conflicts: [] };
}

/** `provider`, except that `write` rejects with whatever `fail(path)` returns. */
function failingWrites(
  provider: StorageProvider,
  fail: (path: string) => Error | undefined,
): StorageProvider {
  return new Proxy(provider, {
    get(obj, prop, receiver) {
      if (prop === "write") {
        return (path: string, content: string, options?: WriteOptions) => {
          const error = fail(path);
          return error ? Promise.reject(error) : obj.write(path, content, options);
        };
      }
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

describe.each(PAIRS)("SyncEngine (%s)", (_name, makePair) => {
  let pair: Pair;
  let primary: StorageProvider;
  let target: StorageProvider;
  let engine: SyncEngine;
  const makeEngine = (exclude?: string[]) =>
    new SyncEngine({ primary, target, now: () => NOW, ...(exclude ? { exclude } : {}) });

  beforeEach(async () => {
    pair = await makePair();
    primary = pair.primary;
    target = pair.target;
    engine = makeEngine();
  });

  afterEach(async () => {
    await engine.stop();
    await pair.cleanup();
  });

  it("copies files both ways on the first sync, then has nothing to do", async () => {
    await seed(primary, { "a.md": "alpha", "Daily/2026-09-23.md": "- [ ] today" });
    await seed(target, { "b.md": "beta" });

    const report = await engine.syncOnce();
    expect(report).toMatchObject({ pushed: ["Daily/2026-09-23.md", "a.md"], pulled: ["b.md"] });
    const expected = { "Daily/2026-09-23.md": "- [ ] today", "a.md": "alpha", "b.md": "beta" };
    expect(await contents(primary)).toEqual(expected);
    expect(await contents(target)).toEqual(expected);

    expect(await engine.syncOnce()).toMatchObject(emptyReport());
  });

  it("pushes vault edits and pulls target edits", async () => {
    await seed(primary, { "a.md": "one", "b.md": "one" });
    await engine.syncOnce();
    await primary.write("a.md", "edited in the vault");
    await target.write("b.md", "edited elsewhere");

    expect(await engine.syncOnce()).toMatchObject({ pushed: ["a.md"], pulled: ["b.md"] });
    expect((await target.read("a.md"))?.content).toBe("edited in the vault");
    expect((await primary.read("b.md"))?.content).toBe("edited elsewhere");
  });

  it("merges concurrent edits to different lines of a note", async () => {
    const base = "# Tasks\n- [ ] one\n- [ ] two\n- [ ] three\n";
    await seed(primary, { "Daily/2026-09-23.md": base });
    await engine.syncOnce();
    await primary.write("Daily/2026-09-23.md", base.replace("- [ ] one", "- [x] one"));
    await target.write("Daily/2026-09-23.md", base.replace("- [ ] three", "- [x] three"));

    const report = await engine.syncOnce();
    expect(report).toMatchObject({ merged: ["Daily/2026-09-23.md"], conflicts: [] });
    const merged = "# Tasks\n- [x] one\n- [ ] two\n- [x] three\n";
    expect((await primary.read("Daily/2026-09-23.md"))?.content).toBe(merged);
    expect((await target.read("Daily/2026-09-23.md"))?.content).toBe(merged);
    expect(await engine.syncOnce()).toMatchObject(emptyReport());
  });

  it("keeps both sides' new tasks when both appended to the same note", async () => {
    await seed(primary, { "todo.md": "- [ ] existing\n" });
    await engine.syncOnce();
    await primary.write("todo.md", "- [ ] existing\n- [ ] from laptop\n");
    await target.write("todo.md", "- [ ] existing\n- [ ] from phone\n");

    expect(await engine.syncOnce()).toMatchObject({ merged: ["todo.md"] });
    const expected = "- [ ] existing\n- [ ] from laptop\n- [ ] from phone\n";
    expect((await primary.read("todo.md"))?.content).toBe(expected);
    expect((await target.read("todo.md"))?.content).toBe(expected);
  });

  it("keeps the vault's text and saves the target's as a conflict copy on both sides", async () => {
    await seed(primary, { "Daily/2026-09-23.md": "- [ ] call the bank\n" });
    await engine.syncOnce();
    await primary.write("Daily/2026-09-23.md", "- [ ] call the bank at 9\n");
    await target.write("Daily/2026-09-23.md", "- [ ] call the bank at 10\n");

    const conflictPath = "Daily/2026-09-23 (conflict 2026-09-23 1830).md";
    const report = await engine.syncOnce();
    expect(report.conflicts).toEqual([{ path: "Daily/2026-09-23.md", conflictPath }]);
    const expected = {
      "Daily/2026-09-23.md": "- [ ] call the bank at 9\n",
      [conflictPath]: "- [ ] call the bank at 10\n",
    };
    expect(await contents(primary)).toEqual(expected);
    expect(await contents(target)).toEqual(expected);
    expect(engine.status().conflicts).toEqual([conflictPath]);
    expect(await engine.syncOnce()).toMatchObject(emptyReport());

    // Resolving (deleting the copy) propagates and clears the status.
    await primary.delete(conflictPath);
    expect(await engine.syncOnce()).toMatchObject({ deletedRemote: [conflictPath] });
    expect(engine.status().conflicts).toEqual([]);
  });

  it("reports conflict copies another device made until they are resolved", async () => {
    await seed(target, {
      "note (conflict 2026-09-22 0915).md": "their copy",
      "notes (conflicted).md": "just a name",
    });
    await engine.syncOnce();
    expect(engine.status().conflicts).toEqual(["note (conflict 2026-09-22 0915).md"]);

    await primary.delete("note (conflict 2026-09-22 0915).md");
    await engine.syncOnce();
    expect(engine.status().conflicts).toEqual([]);
  });

  it("numbers conflict copies that would collide", async () => {
    await seed(primary, {
      "note.md": "base\n",
      "note (conflict 2026-09-23 1830).md": "older copy",
    });
    await engine.syncOnce();
    await primary.write("note.md", "mine\n");
    await target.write("note.md", "theirs\n");
    expect((await engine.syncOnce()).conflicts).toEqual([
      { path: "note.md", conflictPath: "note (conflict 2026-09-23 1830 2).md" },
    ]);
    await primary.write("note.md", "mine again\n");
    await target.write("note.md", "theirs again\n");
    expect((await engine.syncOnce()).conflicts).toEqual([
      { path: "note.md", conflictPath: "note (conflict 2026-09-23 1830 3).md" },
    ]);
    expect((await primary.read("note (conflict 2026-09-23 1830).md"))?.content).toBe("older copy");
  });

  it("lets the newest version of a non-text file win, keeping the other as a copy", async () => {
    await seed(primary, { "board.canvas": '{"nodes":[]}' });
    await engine.syncOnce();

    await target.write("board.canvas", '{"nodes":["target"]}');
    await sleep(20);
    await primary.write("board.canvas", '{"nodes":["vault, newer"]}');
    let report = await engine.syncOnce();
    const copy = "board (conflict 2026-09-23 1830).canvas";
    expect(report.conflicts).toEqual([{ path: "board.canvas", conflictPath: copy }]);
    expect((await target.read("board.canvas"))?.content).toBe('{"nodes":["vault, newer"]}');
    expect((await primary.read(copy))?.content).toBe('{"nodes":["target"]}');

    await primary.write("board.canvas", '{"nodes":["vault"]}');
    await sleep(20);
    await target.write("board.canvas", '{"nodes":["target, newer"]}');
    report = await engine.syncOnce();
    expect(report.conflicts).toHaveLength(1);
    const secondCopy = report.conflicts[0]!.conflictPath;
    expect((await primary.read("board.canvas"))?.content).toBe('{"nodes":["target, newer"]}');
    expect((await target.read(secondCopy))?.content).toBe('{"nodes":["vault"]}');
  });

  it("propagates deletions in both directions", async () => {
    await seed(primary, { "a.md": "a", "b.md": "b", "keep.md": "k" });
    await engine.syncOnce();
    await primary.delete("a.md");
    await target.delete("b.md");

    const report = await engine.syncOnce();
    expect(report).toMatchObject({ deletedRemote: ["a.md"], deletedLocal: ["b.md"] });
    expect(await contents(primary)).toEqual({ "keep.md": "k" });
    expect(await contents(target)).toEqual({ "keep.md": "k" });
  });

  it("restores a file deleted on one side but edited on the other", async () => {
    await seed(primary, { "x.md": "x", "y.md": "y", "keep.md": "k" });
    await engine.syncOnce();
    await primary.delete("x.md");
    await target.write("x.md", "x edited remotely");
    await target.delete("y.md");
    await primary.write("y.md", "y edited in the vault");

    const report = await engine.syncOnce();
    expect(report).toMatchObject({
      pulled: ["x.md"],
      pushed: ["y.md"],
      deletedLocal: [],
      deletedRemote: [],
    });
    const expected = {
      "keep.md": "k",
      "x.md": "x edited remotely",
      "y.md": "y edited in the vault",
    };
    expect(await contents(primary)).toEqual(expected);
    expect(await contents(target)).toEqual(expected);
  });

  it("forgets files deleted on both sides", async () => {
    await seed(primary, { "gone.md": "x", "keep.md": "k" });
    await engine.syncOnce();
    await primary.delete("gone.md");
    await target.delete("gone.md");
    expect(await engine.syncOnce()).toMatchObject(emptyReport());
    await target.write("gone.md", "recreated");
    expect(await engine.syncOnce()).toMatchObject({ pulled: ["gone.md"] });
  });

  it("settles files created on both sides: identical silently, different as a conflict", async () => {
    await seed(primary, { "same.md": "same", "diff.md": "vault" });
    await seed(target, { "same.md": "same", "diff.md": "target" });
    const report = await engine.syncOnce();
    expect(report).toMatchObject({ pushed: [], pulled: [], merged: [] });
    expect(report.conflicts).toEqual([
      { path: "diff.md", conflictPath: "diff (conflict 2026-09-23 1830).md" },
    ]);
    expect((await target.read("diff.md"))?.content).toBe("vault");
  });

  it("never syncs its own state, excluded paths, temp files or binaries", async () => {
    engine = makeEngine(["Private"]);
    await seed(primary, {
      [`${SYNC_STATE_DIR}/other-target.json`]: "{}",
      ".daily-do-list/threads/t1.json": '{"id":"t1"}',
      "Private/journal.md": "secret",
      "image.png": "not really a png",
      "note.md": "hello",
    });
    await seed(target, { "Private/remote.md": "stays remote", "Notes/a.md~": "editor backup" });
    await engine.syncOnce();

    expect(await target.read(".daily-do-list/threads/t1.json")).not.toBeNull();
    expect(await target.read("note.md")).not.toBeNull();
    for (const path of [
      `${SYNC_STATE_DIR}/other-target.json`,
      snapshotPath(target.id),
      "Private/journal.md",
      "image.png",
    ]) {
      expect(await target.read(path)).toBeNull();
    }
    expect(await primary.read("Private/remote.md")).toBeNull();
    expect(await primary.read("Notes/a.md~")).toBeNull();
  });

  it("persists the merge base so a restarted engine still merges", async () => {
    const base = "line 1\nline 2\nline 3\nline 4\n";
    await seed(primary, { "note.md": base });
    await engine.syncOnce();
    expect(await primary.read(snapshotPath(target.id))).not.toBeNull();

    const restarted = makeEngine();
    await primary.write("note.md", base.replace("line 1", "LINE 1"));
    await target.write("note.md", base.replace("line 4", "LINE 4"));
    expect(await restarted.syncOnce()).toMatchObject({ merged: ["note.md"], conflicts: [] });
    expect((await target.read("note.md"))?.content).toBe("LINE 1\nline 2\nline 3\nLINE 4\n");
  });

  it("ignores an unreadable snapshot without deleting anything", async () => {
    await seed(primary, { "a.md": "a" });
    await engine.syncOnce();
    await target.delete("a.md");
    await primary.write(snapshotPath(target.id), "{ not json");
    const report = await makeEngine().syncOnce();
    expect(report).toMatchObject({ pushed: ["a.md"], deletedLocal: [] });
  });

  it("refuses to mirror a wiped target into the vault", async () => {
    await seed(primary, { "a.md": "a", "b.md": "b" });
    await engine.syncOnce();
    await target.delete("a.md");
    await target.delete("b.md");

    await expect(engine.syncOnce()).rejects.toBeInstanceOf(SyncAbortedError);
    expect(Object.keys(await contents(primary))).toEqual(["a.md", "b.md"]);
    expect(engine.status()).toMatchObject({ state: "error" });
    expect(engine.status().lastError).toMatch(/refusing to delete 2 synced file/);
  });

  it("treats evicted cloud placeholders as unavailable, not deleted", async () => {
    await seed(primary, { "Daily/a.md": "a", "keep.md": "k" });
    await engine.syncOnce();
    await target.delete("Daily/a.md");
    await target.write("Daily/.a.md.icloud", "placeholder");

    const report = await engine.syncOnce();
    expect(report.deletedLocal).toEqual([]);
    expect((await primary.read("Daily/a.md"))?.content).toBe("a");
    expect(engine.status().pendingChanges).toBe(1);
  });

  it("retries a path whose write lost a race", async () => {
    await seed(primary, { "a.md": "a", "b.md": "b" });
    let failNext = true;
    const flaky = failingWrites(target, (path) => {
      if (!failNext || path !== "a.md") return undefined;
      failNext = false;
      return new ConflictError(path, "someone-else");
    });
    engine = new SyncEngine({ primary, target: flaky, now: () => NOW });

    expect(await engine.syncOnce()).toMatchObject({ pushed: ["b.md"] });
    expect(engine.status()).toMatchObject({ state: "idle", pendingChanges: 1 });
    expect(await engine.syncOnce()).toMatchObject({ pushed: ["a.md"] });
    expect(engine.status().pendingChanges).toBe(0);
  });

  it("reports per-file failures without failing the whole run", async () => {
    await seed(primary, { "a.md": "a", "b.md": "b" });
    const broken = failingWrites(target, (path) =>
      path === "a.md" ? new StorageError("disk full", path) : undefined,
    );
    engine = new SyncEngine({ primary, target: broken, now: () => NOW });
    expect(await engine.syncOnce()).toMatchObject({ pushed: ["b.md"] });
    expect(engine.status()).toMatchObject({ state: "idle", pendingChanges: 1 });
    expect(engine.status().lastError).toMatch(/Could not sync 1 file\(s\): a\.md: disk full/);
  });

  it("retries saving the snapshot after a failed save", async () => {
    await seed(primary, { "a.md": "a" });
    let failSnapshot = true;
    const flakyVault = failingWrites(primary, (path) => {
      if (!failSnapshot || path !== snapshotPath(target.id)) return undefined;
      failSnapshot = false;
      return new StorageError("disk full", path);
    });
    engine = new SyncEngine({ primary: flakyVault, target, now: () => NOW });
    await expect(engine.syncOnce()).rejects.toThrow("disk full");
    expect(await primary.read(snapshotPath(target.id))).toBeNull();

    expect(await engine.syncOnce()).toMatchObject(emptyReport());
    expect(await primary.read(snapshotPath(target.id))).not.toBeNull();
    expect(engine.status()).toMatchObject({ state: "idle" });
  });

  it("publishes status transitions", async () => {
    const states: SyncStatus["state"][] = [];
    const off = engine.onStatus((status) => states.push(status.state));
    await seed(primary, { "a.md": "a" });
    await engine.syncOnce();
    off();
    expect(states).toEqual(["syncing", "idle"]);
    expect(engine.status()).toMatchObject({
      state: "idle",
      target: "local",
      lastSyncedAt: NOW,
      pendingChanges: 0,
      conflicts: [],
    });
    expect(engine.status().lastError).toBeUndefined();
  });

  it("never overlaps runs: calls during a run share one follow-up run", async () => {
    await seed(primary, { "a.md": "a" });
    const first = engine.syncOnce();
    const second = engine.syncOnce();
    const third = engine.syncOnce();
    expect(second).toBe(third);
    expect(second).not.toBe(first);
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.pushed).toEqual(["a.md"]);
    expect(r2).toMatchObject(emptyReport());
  });

  it("syncs vault changes automatically after start() and stops on stop()", async () => {
    let runs = 0;
    engine.onStatus((status) => {
      if (status.state === "syncing") runs++;
    });
    engine.start({ debounceMs: 40, intervalMs: 60_000 });
    await vi.waitFor(() => expect(engine.status().lastSyncedAt).not.toBeNull(), { timeout: 5_000 });
    const runsAfterStart = runs;

    await primary.write("one.md", "1");
    await primary.write("two.md", "2");
    await primary.write("three.md", "3");
    await vi.waitFor(
      async () =>
        expect(Object.keys(await contents(target)).sort()).toEqual([
          "one.md",
          "three.md",
          "two.md",
        ]),
      { timeout: 5_000, interval: 20 },
    );
    expect(runs - runsAfterStart).toBeLessThanOrEqual(2);

    await engine.stop();
    await primary.write("after-stop.md", "x");
    await sleep(200);
    expect(await target.read("after-stop.md")).toBeNull();
  });

  it("syncs changes the target reports from elsewhere without waiting for the interval", async () => {
    engine.start({ debounceMs: 60_000, intervalMs: 60_000, targetDebounceMs: 30 });
    await vi.waitFor(() => expect(engine.status().lastSyncedAt).not.toBeNull(), { timeout: 5_000 });
    await pair.targetWatchReady();

    await pair.externalTargetWrite("Daily/from-elsewhere.md", "- [ ] made on another device");
    await vi.waitFor(
      async () =>
        expect((await primary.read("Daily/from-elsewhere.md"))?.content).toBe(
          "- [ ] made on another device",
        ),
      { timeout: 5_000, interval: 20 },
    );
  });

  it("does not run for the target's own writes or for changes it never syncs", async () => {
    let runs = 0;
    engine.onStatus((status) => {
      if (status.state === "syncing") runs++;
    });
    engine.start({ debounceMs: 60_000, intervalMs: 60_000, targetDebounceMs: 20 });
    await vi.waitFor(() => expect(engine.status().lastSyncedAt).not.toBeNull(), { timeout: 5_000 });
    await pair.targetWatchReady();
    const runsAfterStart = runs;

    await target.write("written-through-the-provider.md", "self");
    await pair.externalTargetWrite(`${SYNC_STATE_DIR}/elsewhere.json`, "{}");
    await pair.externalTargetWrite("photo.png", "not synced");
    await sleep(300);
    expect(runs).toBe(runsAfterStart);
    expect(await primary.read("written-through-the-provider.md")).toBeNull();
  });

  it("refuses to sync a storage with itself", () => {
    expect(() => new SyncEngine({ primary, target: primary })).toThrow(StorageError);
  });
});

describe("SyncEngine with fenced agent files", () => {
  const THREAD = ".daily-do-list/threads/thr_1.json";
  let primary: MemoryStorageProvider;
  let target: MemoryStorageProvider;
  let epoch: number | null;
  /** The target refuses fenced changes as made under an earlier grant. */
  let stale: boolean;
  let engine: SyncEngine;

  beforeEach(() => {
    primary = new MemoryStorageProvider({ id: "vault" });
    target = new MemoryStorageProvider({ id: "service" });
    epoch = 1;
    stale = false;
    const write = target.write.bind(target);
    target.write = async (path, content, options) => {
      if (stale && isAgentOwnedPath(path)) throw new StaleLeaseError(path, "stale", 2);
      return write(path, content, options);
    };
    engine = new SyncEngine({
      primary,
      target,
      now: () => NOW,
      fence: { covers: isAgentOwnedPath, epoch: () => epoch },
    });
  });

  const read = async (provider: StorageProvider, path: string) =>
    (await provider.read(path))?.content;

  it("lets the lease holder push its version, without merging or conflict copies", async () => {
    await seed(primary, { [THREAD]: '{"v":"base"}' });
    await engine.syncOnce();
    await primary.write(THREAD, '{"v":"ours"}');
    target.simulateExternalChange(THREAD, '{"v":"theirs"}');
    const report = await engine.syncOnce();
    expect(report).toMatchObject({ pushed: [THREAD], conflicts: [] });
    expect(await read(target, THREAD)).toBe('{"v":"ours"}');
    expect((await primary.list({ includeHidden: true })).map((f) => f.path)).not.toContain(
      expect.stringContaining("conflict"),
    );
  });

  it("takes the holder's version when this device doesn't hold the lease", async () => {
    await seed(primary, { [THREAD]: '{"v":"base"}', ".daily-do-list/state/records.json": "[1]" });
    await engine.syncOnce();
    epoch = null;
    await primary.write(THREAD, '{"v":"written offline"}');
    await primary.write(".daily-do-list/state/records.json", "[1,2]");
    await primary.write(".daily-do-list/threads/thr_new.json", '{"v":"new"}');
    target.simulateExternalChange(".daily-do-list/state/records.json", "[1,3]");
    await primary.write(".daily-do-list/settings.json", '{"theme":"dark"}');
    await primary.write("Inbox/note.md", "- [ ] still syncs");

    const report = await engine.syncOnce();
    expect(await read(primary, THREAD)).toBe('{"v":"base"}');
    expect(await read(primary, ".daily-do-list/state/records.json")).toBe("[1,3]");
    expect(await read(target, THREAD)).toBe('{"v":"base"}');
    expect(await read(target, ".daily-do-list/settings.json")).toBe('{"theme":"dark"}');
    expect(await read(target, "Inbox/note.md")).toBe("- [ ] still syncs");
    // Never on the service, so nothing to take instead: it stays here, unsent.
    expect(await read(primary, ".daily-do-list/threads/thr_new.json")).toBe('{"v":"new"}');
    expect(await target.read(".daily-do-list/threads/thr_new.json")).toBeNull();
    expect(report.conflicts).toEqual([]);
    expect(engine.status().pendingChanges).toBe(0);

    // Once it holds the lease again, the file goes out.
    epoch = 3;
    await engine.syncOnce();
    expect(await read(target, ".daily-do-list/threads/thr_new.json")).toBe('{"v":"new"}');
  });

  it("drops what the service refuses as written under an earlier grant", async () => {
    await seed(primary, { [THREAD]: '{"v":"base"}', ".daily-do-list/threads/thr_2.json": "{}" });
    await engine.syncOnce();
    await primary.write(THREAD, '{"v":"stale"}');
    await target.delete(".daily-do-list/threads/thr_2.json");
    await primary.write(".daily-do-list/threads/thr_2.json", '{"v":"edited"}');
    target.simulateExternalChange(THREAD, '{"v":"new holder"}');
    stale = true;
    const report = await engine.syncOnce();
    expect(await read(primary, THREAD)).toBe('{"v":"new holder"}');
    expect(await primary.read(".daily-do-list/threads/thr_2.json")).toBeNull();
    expect(await read(target, THREAD)).toBe('{"v":"new holder"}');
    expect(report.conflicts).toEqual([]);
    expect(engine.status()).toMatchObject({ state: "idle", pendingChanges: 0 });
    expect(engine.status().lastError).toBeUndefined();
  });

  it("pulls the holder's changes like any other", async () => {
    epoch = null;
    target.simulateExternalChange(THREAD, '{"v":"holder"}');
    expect(await engine.syncOnce()).toMatchObject({ pulled: [THREAD] });
    expect(await read(primary, THREAD)).toBe('{"v":"holder"}');
  });
});

describe("SyncEngine with a target that can't be watched", () => {
  it("keeps syncing on the interval", async () => {
    const primary = new MemoryStorageProvider({ id: "vault" });
    const inner = new MemoryStorageProvider({ id: "mirror" });
    const target = new Proxy(inner, {
      get(obj, prop, receiver) {
        if (prop === "capabilities") return { ...obj.capabilities, watch: false };
        if (prop === "watch") return () => expect.unreachable("an unwatchable target was watched");
        const value = Reflect.get(obj, prop, receiver);
        return typeof value === "function" ? value.bind(obj) : value;
      },
    });
    const engine = new SyncEngine({ primary, target, now: () => NOW });
    engine.start({ debounceMs: 60_000, intervalMs: 50 });
    try {
      inner.simulateExternalChange("a.md", "polled");
      await vi.waitFor(async () => expect((await primary.read("a.md"))?.content).toBe("polled"), {
        timeout: 5_000,
      });
    } finally {
      await engine.stop();
    }
  });
});
