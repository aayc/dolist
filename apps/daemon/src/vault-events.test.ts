import type { StorageEvent } from "@ddl/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultChangeBatcher, type VaultChangedEvent } from "./vault-events";
import { WriteTracker } from "./write-tracker";

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const writes = new WriteTracker();
  const emitted: VaultChangedEvent[] = [];
  const batcher = new VaultChangeBatcher({ writes, delayMs: 30, emit: (e) => emitted.push(e) });
  return { writes, emitted, batcher };
}

const event = (kind: StorageEvent["kind"], path: string, version?: string, self = true) =>
  ({ kind, path, self, ...(version ? { version } : {}) }) as StorageEvent;

describe("WriteTracker", () => {
  it("attributes tracked writes, sidecar/in-process writes and external edits", () => {
    const writes = new WriteTracker();
    writes.record("a.md", "v1", { origin: "client", clientId: "tab-1" });
    writes.record("b.md", "v1", { origin: "sync" });
    writes.record("c.md", undefined, { origin: "client" });
    expect(writes.attribute(event("modified", "a.md", "v1"))).toEqual({
      origin: "client",
      clientId: "tab-1",
    });
    expect(writes.attribute(event("modified", "a.md", "v2", false))).toEqual({
      origin: "external",
    });
    expect(writes.attribute(event("modified", "b.md", "v1"))).toEqual({ origin: "sync" });
    expect(writes.attribute(event("deleted", "c.md"))).toEqual({ origin: "client" });
    expect(writes.attribute(event("modified", "d.md", "v1", true))).toEqual({ origin: "agent" });
    expect(writes.attribute(event("modified", ".daily-do-list/x.json", "v1", false))).toEqual({
      origin: "agent",
    });
  });

  it("forgets entries after the TTL and caps its size", () => {
    let now = 0;
    const writes = new WriteTracker({ ttlMs: 100, maxEntries: 2, now: () => now });
    writes.record("a.md", "v1", { origin: "client", clientId: "t" });
    now = 101;
    expect(writes.attribute(event("modified", "a.md", "v1", false))).toEqual({
      origin: "external",
    });
    writes.record("b.md", "v1", { origin: "sync" });
    writes.record("c.md", "v1", { origin: "sync" });
    writes.record("d.md", "v1", { origin: "sync" });
    expect(writes.attribute(event("modified", "b.md", "v1", false)).origin).toBe("external");
    expect(writes.attribute(event("modified", "d.md", "v1", false)).origin).toBe("sync");
  });
});

describe("VaultChangeBatcher", () => {
  it("coalesces a burst into one event per origin and one change per path", () => {
    const { writes, emitted, batcher } = setup();
    batcher.push(event("created", "new.md", "v1"));
    batcher.push(event("modified", "new.md", "v2"));
    batcher.push(event("modified", "Obsidian.md", "x1", false));
    writes.record("new.md", "v2", { origin: "client", clientId: "tab-1" });
    expect(emitted).toEqual([]);
    vi.advanceTimersByTime(30);
    expect(emitted).toEqual([
      {
        type: "vault.changed",
        origin: "client",
        clientId: "tab-1",
        changes: [{ path: "new.md", kind: "created", version: "v2" }],
      },
      {
        type: "vault.changed",
        origin: "external",
        changes: [{ path: "Obsidian.md", kind: "modified", version: "x1" }],
      },
    ]);
  });

  it("reports delete-then-create as a modification and skips hidden paths", () => {
    const { emitted, batcher } = setup();
    batcher.push(event("deleted", "a.md", undefined, false));
    batcher.push(event("created", "a.md", "v3", false));
    batcher.push(event("modified", ".daily-do-list/threads/t.json", "v1"));
    batcher.push(event("modified", ".obsidian/workspace.json", "v1", false));
    batcher.flush();
    expect(emitted).toEqual([
      {
        type: "vault.changed",
        origin: "external",
        changes: [{ path: "a.md", kind: "modified", version: "v3" }],
      },
    ]);
  });
});
