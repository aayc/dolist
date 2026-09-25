/**
 * End to end: two "devices" (two vault folders, each with a SyncEngine and a RemoteStorageProvider)
 * sharing one vault on an in-process sync server over loopback.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsStorageProvider } from "../local-fs";
import type { RemoteStorageProvider } from "../remote";
import { startTestSyncServer, type TestSyncServer } from "../testing/sync-server";
import { SyncEngine, type SyncStartOptions } from "./engine";
import { SYNC_STATE_DIR, snapshotPath } from "./snapshot";

/** 2026-09-23 18:30 local time: conflict copies are stamped "2026-09-23 1830". */
const NOW = new Date(2026, 8, 23, 18, 30).getTime();
const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;
const FAST: SyncStartOptions = { debounceMs: 100, targetDebounceMs: 50, intervalMs: 3_600_000 };

interface Device {
  vault: LocalFsStorageProvider;
  remote: RemoteStorageProvider;
  engine: SyncEngine;
}

/** Every synced file with its content (each device's own sync bookkeeping excluded). */
async function contents(device: Device): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await device.vault.list({ includeHidden: true })) {
    if (entry.path.startsWith(`${SYNC_STATE_DIR}/`)) continue;
    out[entry.path] = (await device.vault.read(entry.path))?.content ?? "<missing>";
  }
  return out;
}

const eventually = (assertion: () => Promise<void>) =>
  vi.waitFor(assertion, { timeout: 15_000 * TIME_SCALE, interval: 25 });

describe("two devices syncing through the sync service", { timeout: 30_000 * TIME_SCALE }, () => {
  let sync: TestSyncServer;
  let dir: string;
  let devices: Device[];

  async function device(name: string, options: SyncStartOptions = FAST): Promise<Device> {
    const vault = new LocalFsStorageProvider({ root: join(dir, name) });
    await vault.init();
    const remote = sync.provider(`dev_${name}`);
    const engine = new SyncEngine({ primary: vault, target: remote, now: () => NOW });
    const created: Device = { vault, remote, engine };
    devices.push(created);
    engine.start(options);
    await vault.whenWatchReady();
    await vi.waitFor(() => expect(engine.status().lastSyncedAt).not.toBeNull(), { timeout: 5_000 });
    await vi.waitFor(() => expect(remote.streamConnected).toBe(true), { timeout: 5_000 });
    return created;
  }

  /** Both devices agree and nothing is pending. */
  async function settled(a: Device, b: Device): Promise<Record<string, string>> {
    let agreed: Record<string, string> = {};
    await eventually(async () => {
      agreed = await contents(a);
      expect(await contents(b)).toEqual(agreed);
      for (const d of [a, b]) {
        expect(d.engine.status()).toMatchObject({ state: "idle", pendingChanges: 0 });
      }
    });
    return agreed;
  }

  beforeEach(async () => {
    sync = await startTestSyncServer();
    dir = await mkdtemp(join(tmpdir(), "ddl-two-devices-"));
    devices = [];
  });

  afterEach(async () => {
    for (const d of devices) await d.engine.stop();
    for (const d of devices) await d.vault.dispose();
    await sync.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("shows an edit on one device on the other within about two seconds, not the 30 s interval", async () => {
    const defaults: SyncStartOptions = {};
    const a = await device("a", defaults);
    const b = await device("b", defaults);

    const started = performance.now();
    await a.vault.write("Daily/2026-09-24.md", "- [ ] water the plants\n");
    await vi.waitFor(
      async () =>
        expect((await b.vault.read("Daily/2026-09-24.md"))?.content).toBe(
          "- [ ] water the plants\n",
        ),
      { timeout: 10_000 * TIME_SCALE, interval: 20 },
    );
    // Default quiet periods: 1.5 s on the editing device, 0.25 s on the receiving one.
    expect(performance.now() - started).toBeLessThan(2_500 * TIME_SCALE);
  });

  it("merges concurrent edits to different lines of a note on both devices", async () => {
    const a = await device("a");
    const b = await device("b");
    const base = "# Tasks\n- [ ] one\n- [ ] two\n- [ ] three\n";
    await a.vault.write("Daily/2026-09-24.md", base);
    await settled(a, b);

    await a.vault.write("Daily/2026-09-24.md", base.replace("- [ ] one", "- [x] one"));
    await b.vault.write("Daily/2026-09-24.md", base.replace("- [ ] three", "- [x] three"));

    expect(await settled(a, b)).toEqual({
      "Daily/2026-09-24.md": "# Tasks\n- [x] one\n- [ ] two\n- [x] three\n",
    });
  });

  it("keeps a conflict copy on both devices when both edit the same line", async () => {
    const a = await device("a");
    const b = await device("b");
    await a.vault.write("Daily/2026-09-24.md", "- [ ] call the bank\n");
    await settled(a, b);

    await a.vault.write("Daily/2026-09-24.md", "- [ ] call the bank at 9\n");
    await b.vault.write("Daily/2026-09-24.md", "- [ ] call the bank at 10\n");

    const files = await settled(a, b);
    const copy = "Daily/2026-09-24 (conflict 2026-09-23 1830).md";
    expect(Object.keys(files).sort()).toEqual([copy, "Daily/2026-09-24.md"]);
    expect([files["Daily/2026-09-24.md"], files[copy]].sort()).toEqual([
      "- [ ] call the bank at 10\n",
      "- [ ] call the bank at 9\n",
    ]);
    for (const d of [a, b]) {
      await eventually(async () => expect(d.engine.status().conflicts).toContain(copy));
    }
  });

  it("propagates deletions", async () => {
    const a = await device("a");
    const b = await device("b");
    await a.vault.write("Inbox/old.md", "done with this");
    await a.vault.write("keep.md", "keep");
    await settled(a, b);

    await b.vault.delete("Inbox/old.md");
    expect(await settled(a, b)).toEqual({ "keep.md": "keep" });
  });

  it("syncs the agent's sidecar files but never the per-device sync snapshots", async () => {
    const a = await device("a");
    const b = await device("b");
    const thread = JSON.stringify({ format: 1, id: "thr_k3j9x0q2m1ab", title: "Find a dentist" });
    await a.vault.write(".daily-do-list/threads/thr_k3j9x0q2m1ab.json", thread);
    expect(await settled(a, b)).toEqual({
      ".daily-do-list/threads/thr_k3j9x0q2m1ab.json": thread,
    });

    const snapshot = snapshotPath(a.remote.id);
    expect(await a.vault.read(snapshot)).not.toBeNull();
    expect(await b.vault.read(snapshot)).not.toBeNull();
    const onServer = sync.server.store.listFiles(sync.vault, "").files.map((f) => f.path);
    expect(onServer).toEqual([".daily-do-list/threads/thr_k3j9x0q2m1ab.json"]);
  });
});
