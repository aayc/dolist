import { mkdir, mkdtemp, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsStorageProvider } from "./local-fs";
import { contentVersion } from "./memory";
import { untilEventsFlow } from "./testing/fs-events";
import type { StorageEvent } from "./types";

// fs events are asynchronous and batched by the OS: poll generously, and give "nothing happened"
// assertions enough time for a (suppressed) echo to have arrived.
const EVENT_TIMEOUT = { timeout: 10_000, interval: 20 };
const QUIET_MS = 500;

const { setTimeout: realSetTimeout } = globalThis;

/** Waits `ms` of real time, letting the watcher's frozen timers (see `startWatching`) keep up. */
async function letTimePass(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await new Promise((resolve) => realSetTimeout(resolve, 20));
    if (vi.isFakeTimers()) vi.advanceTimersByTime(20);
  }
}

function describeEvent(e: StorageEvent): string {
  return `${e.kind} ${e.path}${e.self ? " (self)" : ""}`;
}

describe("LocalFsStorageProvider.watch", { timeout: 60_000 }, () => {
  let dir: string;
  let root: string;
  let s: LocalFsStorageProvider;
  let events: StorageEvent[];
  let unsubscribe: (() => void) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ddl-watch-"));
    root = join(dir, "vault");
    s = new LocalFsStorageProvider({ root, watchDebounceMs: 30 });
    await s.init();
    events = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    unsubscribe?.();
    await s.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Subscribes, proves the OS event stream is live by waiting for a sentinel's event, then freezes
   * the watcher's timers. Events still arrive, but the watcher looks at a path only when the test
   * lets time pass (`vi.waitFor` does on every check, `letTimePass` too), so it sees each change
   * the test makes complete: on a busy machine a `writeFile` can otherwise be caught between its
   * truncate and its write, or a save between its steps, and outlast the quiet period.
   */
  async function startWatching(): Promise<void> {
    vi.useRealTimers();
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldClearNativeTimers: true });
  }

  function eventsFor(path: string): string[] {
    return events.filter((e) => e.path === path).map(describeEvent);
  }

  it("reports external creates, modifications and deletes with self: false", async () => {
    await startWatching();
    const file = join(root, "Daily", "2026-09-23.md");
    await mkdir(join(root, "Daily"));
    await writeFile(file, "- [ ] one");
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        kind: "created",
        path: "Daily/2026-09-23.md",
        version: contentVersion("- [ ] one"),
        self: false,
      });
    }, EVENT_TIMEOUT);

    await writeFile(file, "- [x] one");
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        kind: "modified",
        path: "Daily/2026-09-23.md",
        version: contentVersion("- [x] one"),
        self: false,
      });
    }, EVENT_TIMEOUT);

    await unlink(file);
    await vi.waitFor(() => {
      expect(events).toContainEqual({ kind: "deleted", path: "Daily/2026-09-23.md", self: false });
    }, EVENT_TIMEOUT);
    expect(eventsFor("Daily/2026-09-23.md")).toEqual([
      "created Daily/2026-09-23.md",
      "modified Daily/2026-09-23.md",
      "deleted Daily/2026-09-23.md",
    ]);
  });

  it("emits exactly one self event per own change and suppresses the watcher's echo", async () => {
    await startWatching();
    await s.write("a.md", "one");
    await s.write("a.md", "two");
    await s.rename("a.md", "Archive/a.md");
    await s.write(".daily-do-list/threads/t1.json", "{}");
    await s.delete("Archive/a.md");
    await letTimePass(QUIET_MS);
    expect(events.map(describeEvent)).toEqual([
      "created a.md (self)",
      "modified a.md (self)",
      "deleted a.md (self)",
      "created Archive/a.md (self)",
      "created .daily-do-list/threads/t1.json (self)",
      "deleted Archive/a.md (self)",
    ]);
  });

  it("stays quiet when a file is touched or rewritten with the same content", async () => {
    const file = join(root, "same.md");
    await writeFile(file, "unchanged");
    await startWatching();
    await utimes(file, new Date(), new Date(Date.now() + 2_000));
    await writeFile(file, "unchanged");
    await letTimePass(QUIET_MS);
    expect(events).toEqual([]);
  });

  it("coalesces an editor's atomic save into a single modified event", async () => {
    const file = join(root, "note.md");
    await writeFile(file, "v1");
    await startWatching();

    // vim (backupcopy=no): move the original aside, write the new file, drop the backup.
    await rename(file, `${file}~`);
    await writeFile(file, "v2");
    await unlink(`${file}~`);
    await vi.waitFor(
      () => expect(eventsFor("note.md")).toEqual(["modified note.md"]),
      EVENT_TIMEOUT,
    );

    // Write-to-temp-then-rename with a temp name we don't know about.
    await writeFile(join(root, ".note.md.saving"), "v3");
    await rename(join(root, ".note.md.saving"), file);
    await vi.waitFor(
      () => expect(eventsFor("note.md")).toEqual(["modified note.md", "modified note.md"]),
      EVENT_TIMEOUT,
    );
    await letTimePass(QUIET_MS);
    expect(events.map(describeEvent)).toEqual(["modified note.md", "modified note.md"]);
    expect(events.at(-1)?.version).toBe(contentVersion("v3"));
  });

  it("reports hidden paths but never ignored or temp ones", async () => {
    await startWatching();
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "index"), "x");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.md"), "x");
    await writeFile(join(root, ".DS_Store"), "x");
    await writeFile(join(root, ".ddl-tmp-abcdef123456"), "x");
    await mkdir(join(root, ".daily-do-list", "threads"), { recursive: true });
    await writeFile(join(root, ".daily-do-list", "threads", "t.json"), "{}");
    await vi.waitFor(
      () =>
        expect(eventsFor(".daily-do-list/threads/t.json")).toEqual([
          "created .daily-do-list/threads/t.json",
        ]),
      EVENT_TIMEOUT,
    );
    await letTimePass(QUIET_MS);
    expect(events.map(describeEvent)).toEqual(["created .daily-do-list/threads/t.json"]);
  });

  it("reports every file of a folder that was deleted or moved in", async () => {
    await mkdir(join(root, "Old"), { recursive: true });
    await writeFile(join(root, "Old", "a.md"), "a");
    await writeFile(join(root, "Old", "b.md"), "b");
    const outside = join(dir, "incoming", "Projects");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "plan.md"), "plan");
    await startWatching();

    await rm(join(root, "Old"), { recursive: true });
    await rename(outside, join(root, "Projects"));
    await vi.waitFor(() => {
      expect(events.map(describeEvent).sort()).toEqual([
        "created Projects/plan.md",
        "deleted Old/a.md",
        "deleted Old/b.md",
      ]);
    }, EVENT_TIMEOUT);
  });

  it("stops delivering after the last unsubscribe, and resumes on a new subscription", async () => {
    await startWatching();
    unsubscribe?.();
    unsubscribe = undefined;
    await writeFile(join(root, "ignored-while-unwatched.md"), "x");
    await letTimePass(QUIET_MS);
    expect(events).toEqual([]);

    await startWatching();
    await writeFile(join(root, "seen.md"), "x");
    await vi.waitFor(
      () => expect(eventsFor("seen.md")).toEqual(["created seen.md"]),
      EVENT_TIMEOUT,
    );
    expect(eventsFor("ignored-while-unwatched.md")).toEqual([]);
  });

  it("isolates listener failures", async () => {
    s.watch(() => {
      throw new Error("bad listener");
    });
    await startWatching();
    await s.write("a.md", "x");
    expect(events.map(describeEvent)).toEqual(["created a.md (self)"]);
  });
});
