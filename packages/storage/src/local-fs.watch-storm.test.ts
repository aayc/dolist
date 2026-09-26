/**
 * The watcher under bursts: whatever the interleaving, replaying the event stream onto the state
 * the watcher started from must end at what is on disk (nothing lost), no path may get the same
 * event twice in a row (nothing duplicated), and `self` must say who made each change.
 */
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsStorageProvider } from "./local-fs";
import { contentVersion } from "./memory";
import { untilEventsFlow } from "./testing/fs-events";
import type { StorageEvent } from "./types";

const CONVERGE = { timeout: 15_000, interval: 25 };
/** Longer than the debounce plus the delete grace period, so a straggler would show up. */
const QUIET_MS = 120;

describe("LocalFsStorageProvider.watch under bursts", { timeout: 60_000 }, () => {
  let dir: string;
  let root: string;
  let s: LocalFsStorageProvider;
  let events: StorageEvent[];
  let initial: Map<string, string>;
  let unsubscribe: (() => void) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ddl-storm-"));
    root = join(dir, "vault");
    s = new LocalFsStorageProvider({ root, watchDebounceMs: 20 });
    await s.init();
    events = [];
  });

  afterEach(async () => {
    unsubscribe?.();
    await s.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  async function disk(): Promise<Map<string, string>> {
    return new Map((await s.list({ includeHidden: true })).map((f) => [f.path, f.version]));
  }

  /** Subscribes, then proves the OS event stream is live by waiting for a sentinel's event. */
  async function startWatching(): Promise<void> {
    unsubscribe = s.watch((event) => events.push(event));
    await s.whenWatchReady();
    let latest = "";
    await untilEventsFlow(
      async (attempt) => {
        latest = `sentinel ${attempt}`;
        await writeFile(join(root, ".sentinel"), latest);
      },
      () => events.some((e) => e.path === ".sentinel" && e.version === contentVersion(latest)),
    );
    events.length = 0;
    initial = await disk();
  }

  function replay(): Map<string, string> {
    const state = new Map(initial);
    for (const e of events) {
      if (e.kind === "deleted") state.delete(e.path);
      else state.set(e.path, e.version!);
    }
    return state;
  }

  async function expectConsistent(): Promise<void> {
    await vi.waitFor(async () => expect(replay()).toEqual(await disk()), CONVERGE);
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    expect(replay()).toEqual(await disk());
    const last = new Map<string, string>();
    for (const e of events) {
      const signature = `${e.kind}:${e.version ?? ""}`;
      expect(last.get(e.path), `duplicate ${signature} for ${e.path}`).not.toBe(signature);
      last.set(e.path, signature);
    }
  }

  it("keeps up with a storm of external writes", async () => {
    await mkdir(join(root, "Storm"));
    for (let i = 0; i < 8; i++) await writeFile(join(root, "Storm", `f${i}.md`), "v0");
    await startWatching();
    for (let round = 1; round <= 6; round++) {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          writeFile(join(root, "Storm", `f${i}.md`), `v${round}`),
        ),
      );
    }
    await expectConsistent();
    expect(events.every((e) => !e.self)).toBe(true);
    for (let i = 0; i < 8; i++) {
      expect(replay().get(`Storm/f${i}.md`)).toBe(contentVersion("v6"));
    }
  });

  it("settles deletes and immediate re-creations", async () => {
    for (let i = 0; i < 6; i++) await writeFile(join(root, `r${i}.md`), `old ${i}`);
    await startWatching();
    for (let i = 0; i < 6; i++) {
      await unlink(join(root, `r${i}.md`));
      // Half come back with new content, half with the very same bytes.
      await writeFile(join(root, `r${i}.md`), i % 2 ? `new ${i}` : `old ${i}`);
    }
    await unlink(join(root, "r0.md"));
    await expectConsistent();
    expect(replay().has("r0.md")).toBe(false);
    expect(events.filter((e) => e.path === "r2.md")).toEqual([]);
  });

  it("follows rename chains and moved folders", async () => {
    await writeFile(join(root, "a.md"), "chain");
    await mkdir(join(root, "Old", "Deep"), { recursive: true });
    await writeFile(join(root, "Old", "one.md"), "1");
    await writeFile(join(root, "Old", "Deep", "two.md"), "2");
    await startWatching();
    await rename(join(root, "a.md"), join(root, "b.md"));
    await rename(join(root, "b.md"), join(root, "c.md"));
    await rename(join(root, "c.md"), join(root, "d.md"));
    await rename(join(root, "Old"), join(root, "New"));
    await expectConsistent();
    expect([...replay().keys()].sort()).toEqual([
      ".sentinel",
      "New/Deep/two.md",
      "New/one.md",
      "d.md",
    ]);
    expect(replay().get("d.md")).toBe(contentVersion("chain"));
  });

  it("tells its own writes from interleaved external edits", async () => {
    await startWatching();
    const own: string[] = [];
    for (let i = 0; i < 12; i++) {
      own.push((await s.write("mix.md", `own ${i}`)).version);
      await writeFile(join(root, "mix.md"), `external ${i}`);
      own.push((await s.write(`own-${i % 3}.md`, `own file ${i}`)).version);
    }
    await expectConsistent();
    const selfVersions = events.filter((e) => e.self).map((e) => e.version);
    expect(selfVersions).toEqual(own);
    const ownSet = new Set(own);
    for (const e of events.filter((ev) => !ev.self)) {
      expect(ownSet.has(e.version ?? ""), `echo of an own write: ${e.kind} ${e.path}`).toBe(false);
    }
    expect(replay().get("mix.md")).toBe(contentVersion("external 11"));
  });

  it("keeps up while other watchers of the process open and close", async () => {
    // On macOS each one restarts the process's FSEvents stream, losing what changed just before.
    const other = new LocalFsStorageProvider({ root: join(dir, "other") });
    await other.init();
    try {
      await startWatching();
      let unwatch: (() => void) | undefined;
      for (let i = 0; i < 40; i++) {
        await writeFile(join(root, `f${i}.md`), `v${i}`);
        if (i % 2 === 0) unwatch = other.watch(() => {});
        else unwatch?.();
        await other.whenWatchReady();
      }
      await expectConsistent();
    } finally {
      await other.dispose();
    }
  });

  it("reports every file of a folder created in one burst", async () => {
    await startWatching();
    await mkdir(join(root, "Burst", "Nested"), { recursive: true });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        writeFile(join(root, "Burst", i % 2 ? "Nested" : "", `n${i}.md`), `n${i}`),
      ),
    );
    await expectConsistent();
    expect(events.filter((e) => e.kind === "created")).toHaveLength(25);
  });
});
