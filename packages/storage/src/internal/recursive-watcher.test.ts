import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { silentLogger } from "@ddl/core";
import { describe, expect, it, vi } from "vitest";
import { RecursiveWatcher, type WatchFactory } from "./recursive-watcher";

class FakeWatcher extends EventEmitter {
  closed = false;
  readonly listener: (eventType: string, filename: string | null) => void;
  constructor(listener: (eventType: string, filename: string | null) => void) {
    super();
    this.listener = listener;
  }
  close(): void {
    this.closed = true;
  }
}

function setup(options: { failFirstOpens?: number } = {}) {
  const watchers: FakeWatcher[] = [];
  let failures = options.failFirstOpens ?? 0;
  const factory: WatchFactory = (_root, listener) => {
    if (failures > 0) {
      failures--;
      throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
    }
    const watcher = new FakeWatcher(listener);
    watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  };
  const onChange = vi.fn<(path: string) => void>();
  const onRescan = vi.fn<() => void>();
  const watcher = new RecursiveWatcher({
    root: "/vault",
    logger: silentLogger,
    onChange,
    onRescan,
    watchFactory: factory,
    minRestartDelayMs: 5,
    maxRestartDelayMs: 20,
  });
  return { watcher, watchers, onChange, onRescan };
}

describe("RecursiveWatcher", () => {
  it("forwards normalized vault paths and asks for a rescan when the name is unknown", () => {
    const { watcher, watchers, onChange, onRescan } = setup();
    watcher.start();
    watchers[0]!.listener("rename", "Daily/2026-09-23.md");
    watchers[0]!.listener("change", "Daily\\nested\\note.md");
    watchers[0]!.listener("rename", null);
    expect(onChange.mock.calls).toEqual([["Daily/2026-09-23.md"], ["Daily/nested/note.md"]]);
    expect(onRescan).toHaveBeenCalledTimes(1);
    watcher.close();
    expect(watchers[0]!.closed).toBe(true);
  });

  it("rescans when its stream restarts, until it is closed", () => {
    const { watcher, watchers, onRescan } = setup();
    watcher.start();
    watchers[0]!.emit("restart");
    expect(onRescan).toHaveBeenCalledTimes(1);
    watcher.close();
    watchers[0]!.emit("restart");
    expect(onRescan).toHaveBeenCalledTimes(1);
  });

  it("restarts after an error and rescans for missed changes", async () => {
    const { watcher, watchers, onRescan } = setup();
    watcher.start();
    watchers[0]!.emit("error", new Error("watcher died"));
    expect(watchers[0]!.closed).toBe(true);
    expect(watcher.active).toBe(false);
    await vi.waitFor(() => expect(watchers).toHaveLength(2));
    expect(watcher.active).toBe(true);
    expect(onRescan).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it("retries with backoff when the watcher cannot be opened", async () => {
    const { watcher, watchers, onRescan } = setup({ failFirstOpens: 3 });
    watcher.start();
    expect(watcher.active).toBe(false);
    await vi.waitFor(() => expect(watchers).toHaveLength(1), { timeout: 2_000 });
    expect(onRescan).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it("does not restart once closed", async () => {
    const { watcher, watchers } = setup();
    watcher.start();
    watcher.close();
    watchers[0]!.emit("error", new Error("late error"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(watchers).toHaveLength(1);
  });
});
