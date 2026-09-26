/**
 * Changes made while macOS's FSEvents stream restarts (any watch of the process opening or
 * closing) must still be reported. The stream is simulated (`SimulatedFsEvents`), so each test
 * makes the change at exactly the moment the real one loses it, on every OS;
 * `local-fs.watch-storm.test.ts` checks the same against the real stream.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsStorageProvider } from "./local-fs";
import { contentVersion } from "./memory";
import type { StorageEvent } from "./types";

const { fsEvents } = await vi.hoisted(async () => {
  const { SimulatedFsEvents } = await import("./testing/fs-events");
  return { fsEvents: new SimulatedFsEvents() };
});

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: fsEvents.watch,
}));

const EDITED = "# Ideas\n\nEdited elsewhere";

describe("LocalFsStorageProvider.watch while the FSEvents stream restarts", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  let dir: string;
  let root: string;
  let vault: string;
  let versionCache: string;
  let s: LocalFsStorageProvider;
  let other: LocalFsStorageProvider;
  let events: StorageEvent[];

  beforeAll(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", platform);
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ddl-restart-"));
    root = join(dir, "vault");
    versionCache = join(dir, "versions.json");
    await mkdir(root);
    await writeFile(join(root, "Ideas.md"), "# Ideas");
    // Versions come from what a previous run saved, as in the daemon.
    const previous = new LocalFsStorageProvider({ root, versionCache });
    await previous.list();
    await previous.dispose();
    s = new LocalFsStorageProvider({ root, versionCache, watchDebounceMs: 10 });
    await s.init();
    vault = await realpath(root);
    // Another watcher in the process: a second daemon, or a sync mirror.
    other = new LocalFsStorageProvider({ root: join(dir, "other") });
    await other.init();
    events = [];
  });

  afterEach(async () => {
    await s.dispose();
    await other.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes a vault file as another app would; its event is delivered a moment later, or lost. */
  async function edit(path: string, content: string): Promise<void> {
    await writeFile(join(vault, path), content);
    fsEvents.change(join(vault, path));
  }

  async function startWatching(): Promise<void> {
    s.watch((event) => events.push(event));
    await s.whenWatchReady();
    fsEvents.rebuilt();
  }

  function reported(path: string, content: string): Promise<void> {
    const event = { kind: "modified", path, version: contentVersion(content), self: false };
    return vi.waitFor(() => expect(events).toContainEqual(event), { timeout: 2_000 });
  }

  it("reports a change made right before another watch of the process opens, and lists it", async () => {
    await startWatching();
    await edit("Ideas.md", "# Ideas\n\nfirst");
    await reported("Ideas.md", "# Ideas\n\nfirst");
    expect((await s.list()).map((f) => f.version)).toEqual([contentVersion("# Ideas\n\nfirst")]);

    await edit("Ideas.md", EDITED);
    other.watch(() => {});
    await other.whenWatchReady();
    fsEvents.rebuilt();
    await reported("Ideas.md", EDITED);
    expect((await s.list()).map((f) => f.version)).toEqual([contentVersion(EDITED)]);
    await s.dispose();
    const next = new LocalFsStorageProvider({ root, versionCache });
    expect((await next.list()).map((f) => f.version)).toEqual([contentVersion(EDITED)]);
    await next.dispose();
  });

  it("reports a change made right before another watch of the process closes", async () => {
    const unwatch = other.watch(() => {});
    await other.whenWatchReady();
    await startWatching();
    await edit("Ideas.md", EDITED);
    unwatch();
    await reported("Ideas.md", EDITED);
  });

  it("reports a change made right after it starts watching, before its stream runs", async () => {
    s.watch((event) => events.push(event));
    await s.whenWatchReady();
    await edit("Ideas.md", EDITED);
    fsEvents.rebuilt();
    await reported("Ideas.md", EDITED);
  });
});
