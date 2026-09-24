import { API_ROUTES, CLIENT_ID_HEADER, isHiddenPath } from "@ddl/core";
import { MemoryStorageProvider, type StorageEvent, type StorageEventKind } from "@ddl/storage";
import { fc, test } from "@fast-check/vitest";
import { afterEach, describe, expect, it } from "vitest";
import { AttributedStorage } from "../attributed-storage";
import { VaultChangeBatcher, type VaultChangedEvent } from "../vault-events";
import { type WriteSource, WriteTracker } from "../write-tracker";
import { type LiveApp, startLiveApp, TestSocket, waitFor } from "./harness";

const source: fc.Arbitrary<WriteSource> = fc.oneof(
  fc.constant({ origin: "agent" as const }),
  fc.constant({ origin: "sync" as const }),
  fc.constant({ origin: "client" as const }),
  fc.constantFrom("tab_a", "tab_b").map((clientId) => ({ origin: "client" as const, clientId })),
);
const path = fc.constantFrom(
  "a.md",
  "b.md",
  "Daily/c.md",
  ".daily-do-list/t.json",
  ".obsidian/x.json",
);
const version = fc.option(fc.constantFrom("v1", "v2", "v3"), { nil: undefined });

const expectedAttribution = (s: WriteSource) =>
  s.origin === "client" && s.clientId
    ? { origin: "client", clientId: s.clientId }
    : { origin: s.origin };
const fallback = (p: string, self: boolean) =>
  p.startsWith(".daily-do-list") || self ? { origin: "agent" } : { origin: "external" };

describe("WriteTracker", () => {
  type Op =
    | { op: "record"; path: string; version: string | undefined; source: WriteSource }
    | { op: "tick"; ms: number }
    | { op: "attribute"; path: string; version: string | undefined; self: boolean };

  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ op: fc.constant("record" as const), path, version, source }),
    fc.record({ op: fc.constant("tick" as const), ms: fc.integer({ min: 0, max: 60 }) }),
    fc.record({ op: fc.constant("attribute" as const), path, version, self: fc.boolean() }),
  );

  test.prop([
    fc.array(op, { maxLength: 80 }),
    fc.integer({ min: 1, max: 6 }),
    fc.integer({ min: 1, max: 100 }),
  ])(
    "attributes to the latest writer of a (path, version) that is recent and among the newest entries",
    (ops, maxEntries, ttlMs) => {
      let now = 0;
      const tracker = new WriteTracker({ ttlMs, maxEntries, now: () => now });
      // Model: latest record per key, with the time and recency order of that record.
      const latest = new Map<string, { source: WriteSource; at: number }>();
      const key = (p: string, v: string | undefined) => `${p}\u0000${v ?? ""}`;
      for (const step of ops) {
        if (step.op === "tick") now += step.ms;
        else if (step.op === "record") {
          const k = key(step.path, step.version);
          latest.delete(k);
          latest.set(k, { source: step.source, at: now });
          tracker.record(step.path, step.version, step.source);
        } else {
          const k = key(step.path, step.version);
          const newest = [...latest.keys()].slice(-maxEntries);
          const entry = latest.get(k);
          const tracked = entry && newest.includes(k) && now - entry.at < ttlMs;
          const event = { path: step.path, version: step.version, self: step.self };
          expect(tracker.attribute(event)).toEqual(
            tracked ? expectedAttribution(entry.source) : fallback(step.path, step.self),
          );
        }
      }
    },
  );

  it("attributes a burst of writes to the same path to whoever wrote each version", () => {
    const tracker = new WriteTracker();
    tracker.record("a.md", "v1", { origin: "client", clientId: "tab_a" });
    tracker.record("a.md", "v2", { origin: "agent" });
    tracker.record("a.md", "v3", { origin: "client", clientId: "tab_b" });
    tracker.record("a.md", undefined, { origin: "sync" });
    const at = (v: string | undefined) =>
      tracker.attribute({ path: "a.md", version: v, self: true });
    expect(at("v1")).toEqual({ origin: "client", clientId: "tab_a" });
    expect(at("v2")).toEqual({ origin: "agent" });
    expect(at("v3")).toEqual({ origin: "client", clientId: "tab_b" });
    expect(at(undefined)).toEqual({ origin: "sync" });
    expect(tracker.attribute({ path: "a.md", version: "v4", self: false })).toEqual({
      origin: "external",
    });
  });

  it("stays bounded under a write flood", () => {
    let now = 0;
    const tracker = new WriteTracker({ now: () => now });
    for (let i = 0; i < 50_000; i++) {
      tracker.record(`n${i}.md`, `v${i}`, { origin: "client", clientId: "tab_a" });
      now++;
    }
    expect(
      (tracker as unknown as { entries: Map<string, unknown> }).entries.size,
    ).toBeLessThanOrEqual(2_000);
    expect(tracker.attribute({ path: "n49999.md", version: "v49999", self: true })).toMatchObject({
      clientId: "tab_a",
    });
  });
});

describe("VaultChangeBatcher", () => {
  /** Event sequences a real provider can produce for one path (created only when absent, …). */
  const lifecycle = fc
    .tuple(fc.boolean(), fc.array(fc.nat(2), { minLength: 1, maxLength: 12 }))
    .map(([existsBefore, choices]) => {
      const events: StorageEvent[] = [];
      let exists = existsBefore;
      for (const [i, choice] of choices.entries()) {
        const kind: StorageEventKind = !exists ? "created" : choice === 0 ? "deleted" : "modified";
        exists = kind !== "deleted";
        events.push({ kind, path: "p.md", self: true, ...(exists ? { version: `v${i}` } : {}) });
      }
      return { existsBefore, events, existsAfter: exists };
    });

  test.prop([fc.array(lifecycle, { minLength: 1, maxLength: 4 })])(
    "reports the net effect per path: deleted iff gone, created iff it did not exist before",
    (paths) => {
      const emitted: VaultChangedEvent[] = [];
      const batcher = new VaultChangeBatcher({
        writes: new WriteTracker(),
        delayMs: 1e9,
        emit: (e) => emitted.push(e),
      });
      for (const [i, { events }] of paths.entries()) {
        for (const event of events) batcher.push({ ...event, path: `p${i}.md` });
      }
      batcher.flush();
      batcher.cancel();
      const changes = emitted.flatMap((e) => e.changes);
      expect(changes).toHaveLength(paths.length);
      for (const [i, { existsBefore, events, existsAfter }] of paths.entries()) {
        const change = changes.find((c) => c.path === `p${i}.md`)!;
        const expectedKind = !existsAfter ? "deleted" : existsBefore ? "modified" : "created";
        expect(change.kind, JSON.stringify(events)).toBe(expectedKind);
        expect(change.version).toBe(events.at(-1)!.version);
      }
    },
  );

  test.prop([
    fc.array(
      fc.record({
        path: fc.oneof(path, fc.string()),
        kind: fc.constantFrom<StorageEventKind>("created", "modified", "deleted"),
      }),
      { maxLength: 40 },
    ),
  ])("never emits hidden paths and emits each visible path once per window", (events) => {
    const emitted: VaultChangedEvent[] = [];
    const batcher = new VaultChangeBatcher({
      writes: new WriteTracker(),
      delayMs: 1e9,
      emit: (e) => emitted.push(e),
    });
    for (const e of events) batcher.push({ ...e, self: false });
    batcher.flush();
    batcher.cancel();
    const paths = emitted.flatMap((e) => e.changes.map((c) => c.path));
    expect(paths.filter((p) => isHiddenPath(p))).toEqual([]);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(paths)).toEqual(
      new Set(events.map((e) => e.path).filter((p) => !isHiddenPath(p))),
    );
  });

  it("reports a created-deleted-created burst as a creation", () => {
    const emitted: VaultChangedEvent[] = [];
    const batcher = new VaultChangeBatcher({
      writes: new WriteTracker(),
      delayMs: 1e9,
      emit: (e) => emitted.push(e),
    });
    batcher.push({ kind: "created", path: "n.md", version: "v1", self: false });
    batcher.push({ kind: "deleted", path: "n.md", self: false });
    batcher.push({ kind: "created", path: "n.md", version: "v2", self: false });
    batcher.flush();
    expect(emitted).toEqual([
      {
        type: "vault.changed",
        origin: "external",
        changes: [{ path: "n.md", kind: "created", version: "v2" }],
      },
    ]);
  });

  it("attributes a same-path race to the last writer, and splits groups by writer", () => {
    const writes = new WriteTracker();
    const emitted: VaultChangedEvent[] = [];
    const batcher = new VaultChangeBatcher({ writes, delayMs: 1e9, emit: (e) => emitted.push(e) });
    batcher.push({ kind: "modified", path: "race.md", version: "c1", self: true });
    writes.record("race.md", "c1", { origin: "client", clientId: "tab_a" });
    batcher.push({ kind: "modified", path: "race.md", version: "g1", self: true });
    writes.record("race.md", "g1", { origin: "agent" });
    batcher.push({ kind: "modified", path: "race.md", version: "x1", self: false });
    batcher.push({ kind: "modified", path: "a.md", version: "a1", self: true });
    writes.record("a.md", "a1", { origin: "client", clientId: "tab_a" });
    batcher.push({ kind: "modified", path: "b.md", version: "b1", self: true });
    writes.record("b.md", "b1", { origin: "client", clientId: "tab_b" });
    batcher.flush();
    expect(emitted).toEqual([
      {
        type: "vault.changed",
        origin: "external",
        changes: [{ path: "race.md", kind: "modified", version: "x1" }],
      },
      {
        type: "vault.changed",
        origin: "client",
        clientId: "tab_a",
        changes: [{ path: "a.md", kind: "modified", version: "a1" }],
      },
      {
        type: "vault.changed",
        origin: "client",
        clientId: "tab_b",
        changes: [{ path: "b.md", kind: "modified", version: "b1" }],
      },
    ]);
  });
});

describe("AttributedStorage", () => {
  /** Deletes folder contents one file at a time, pausing between files like a slow disk. */
  class SteppedStorage extends MemoryStorageProvider {
    between: () => void = () => {};
    override async deleteFolder(folder: string): Promise<void> {
      for (const file of await this.list({ prefix: folder, includeHidden: true })) {
        await this.delete(file.path);
        this.between();
        await Promise.resolve();
      }
    }
  }

  it("attributes every file of a folder deletion even when the hub flushes mid-way", async () => {
    const storage = new SteppedStorage({
      initialFiles: { "Old/a.md": "a", "Old/b.md": "b", "Old/sub/c.md": "c" },
    });
    const writes = new WriteTracker();
    const emitted: VaultChangedEvent[] = [];
    const batcher = new VaultChangeBatcher({ writes, delayMs: 1e9, emit: (e) => emitted.push(e) });
    storage.watch((event) => batcher.push(event));
    storage.between = () => batcher.flush();
    await new AttributedStorage(storage, writes, { origin: "sync" }).deleteFolder("Old");
    batcher.flush();
    expect(emitted.flatMap((e) => e.changes.map((c) => c.path)).sort()).toEqual([
      "Old/a.md",
      "Old/b.md",
      "Old/sub/c.md",
    ]);
    expect(new Set(emitted.map((e) => e.origin))).toEqual(new Set(["sync"]));
  });

  test.prop([
    fc.array(
      fc.tuple(
        fc.constantFrom("write", "delete", "rename"),
        fc.constantFrom("a.md", "b.md", "c.md"),
        fc.string({ maxLength: 8 }),
      ),
      { maxLength: 20 },
    ),
    source,
  ])("tags every change it makes with its writer", async (ops, writer) => {
    const inner = new MemoryStorageProvider();
    const writes = new WriteTracker();
    const emitted: VaultChangedEvent[] = [];
    const batcher = new VaultChangeBatcher({ writes, delayMs: 1e9, emit: (e) => emitted.push(e) });
    inner.watch((event) => batcher.push(event));
    const storage = new AttributedStorage(inner, writes, writer);
    for (const [kind, p, content] of ops) {
      await (kind === "write"
        ? storage.write(p, content)
        : kind === "delete"
          ? storage.delete(p)
          : storage.rename(p, `moved-${p}`)
      ).catch(() => undefined);
      batcher.flush();
    }
    batcher.cancel();
    for (const event of emitted)
      expect({ origin: event.origin, clientId: event.clientId }).toEqual({
        clientId: undefined,
        ...expectedAttribution(writer),
      });
  });
});

describe("echo suppression over the WebSocket", () => {
  let live: LiveApp<MemoryStorageProvider> | undefined;
  afterEach(async () => {
    await live?.close();
    live = undefined;
  });

  it("tags API writes with the writer's clientId so each tab can ignore exactly its own echoes", async () => {
    live = await startLiveApp({ storage: new MemoryStorageProvider() });
    const tab = await TestSocket.open(live.wsUrl());
    await tab.next("hello");
    const put = (p: string, clientId: string, content: string) =>
      live!.api(API_ROUTES.note(p), {
        method: "PUT",
        headers: { "content-type": "application/json", [CLIENT_ID_HEADER]: clientId },
        body: JSON.stringify({ content }),
      });

    await Promise.all([
      put("a.md", "tab_a", "A"),
      put("b.md", "tab_b", "B"),
      put("c.md", "bad id!", "C"),
    ]);
    const events: VaultChangedEvent[] = [];
    await waitFor(() => {
      while (tab.events.some((e) => e.type === "vault.changed")) {
        const index = tab.events.findIndex((e) => e.type === "vault.changed");
        events.push(tab.events.splice(index, 1)[0] as VaultChangedEvent);
      }
      return events.flatMap((e) => e.changes).length === 3;
    });
    const byPath = new Map(events.flatMap((e) => e.changes.map((c) => [c.path, e] as const)));
    expect(byPath.get("a.md")).toMatchObject({ origin: "client", clientId: "tab_a" });
    expect(byPath.get("b.md")).toMatchObject({ origin: "client", clientId: "tab_b" });
    expect(byPath.get("c.md")?.origin).toBe("client");
    expect(byPath.get("c.md")?.clientId).toBeUndefined();
    tab.ws.terminate();
  });

  it("does not let a tab suppress a change the agent or another app made right after its own write", async () => {
    live = await startLiveApp({ storage: new MemoryStorageProvider(), hub: { coalesceMs: 50 } });
    const tab = await TestSocket.open(live.wsUrl());
    await tab.next("hello");
    const agent = new AttributedStorage(live.storage, live.writes, { origin: "agent" });
    const res = await live.api(API_ROUTES.note("race.md"), {
      method: "PUT",
      headers: { "content-type": "application/json", [CLIENT_ID_HEADER]: "tab_a" },
      body: JSON.stringify({ content: "mine" }),
    });
    expect(res.status).toBe(201);
    await agent.write("race.md", "agent edit");
    const afterAgent = await tab.next("vault.changed");
    expect(afterAgent).toMatchObject({
      origin: "agent",
      changes: [{ path: "race.md", kind: "created" }],
    });
    expect(afterAgent.clientId).toBeUndefined();

    await live.api(API_ROUTES.note("race.md"), {
      method: "PUT",
      headers: { "content-type": "application/json", [CLIENT_ID_HEADER]: "tab_a" },
      body: JSON.stringify({ content: "mine again" }),
    });
    live.storage.simulateExternalChange("race.md", "obsidian edit");
    const afterExternal = await tab.next("vault.changed");
    expect(afterExternal).toMatchObject({
      origin: "external",
      changes: [{ path: "race.md", kind: "modified" }],
    });
    tab.ws.terminate();
  });

  /** Renames each file after a real delay, like a large folder on disk. */
  class SlowRenameStorage extends MemoryStorageProvider {
    override async rename(from: string, to: string) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      return super.rename(from, to);
    }
  }

  // BUG (routes/notes.ts, not owned here): folder renames and folder deletes record their moves in
  // the WriteTracker only after the whole operation finishes. When moving the files takes longer
  // than the hub's coalescing window (a few hundred files on disk), the early events are flushed
  // unattributed and reach clients as `origin: "agent"`, so the tab that did it cannot recognize
  // its own echo. Expected: every change tagged with the writer's clientId. The route could record
  // each move as it happens (e.g. an `onMoved` callback from vault-ops' moveFolder).
  it.fails("tags every file of a slow folder rename with the writer's clientId", async () => {
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`Big/n${i}.md`, `${i}`]));
    live = await startLiveApp({
      storage: new SlowRenameStorage({ initialFiles: files }),
      hub: { coalesceMs: 2 },
    });
    const tab = await TestSocket.open(live.wsUrl());
    await tab.next("hello");
    const res = await live.api(API_ROUTES.rename, {
      method: "POST",
      headers: { "content-type": "application/json", [CLIENT_ID_HEADER]: "tab_a" },
      body: JSON.stringify({ from: "Big", to: "Moved" }),
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const changed = tab.events.filter((e): e is VaultChangedEvent => e.type === "vault.changed");
    expect(changed.flatMap((e) => e.changes)).toHaveLength(12);
    for (const event of changed)
      expect(event).toMatchObject({ origin: "client", clientId: "tab_a" });
    tab.ws.terminate();
  });
});
