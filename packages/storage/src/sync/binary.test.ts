import { SYNC_LIMITS } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { binaryDigest } from "../binary";
import { MemoryStorageProvider } from "../memory";
import { startTestSyncServer } from "../testing/sync-server";
import { StorageError, type StorageProvider } from "../types";
import { SyncEngine } from "./engine";

const a = new Uint8Array([0, 255, 13, 10, 128, 1]);
const b = new Uint8Array([0, 254, 10, 13, 129, 2]);
const path = "Assets/sample.bin";

async function bytes(provider: StorageProvider, file = path) {
  return (await provider.readBinary(file))?.bytes;
}

describe("binary sync", () => {
  it("copies exact bytes through the real sync service, resumes its snapshot and propagates deletion", async () => {
    const sync = await startTestSyncServer();
    const primary = new MemoryStorageProvider({ id: "phone" });
    const other = new MemoryStorageProvider({ id: "desktop" });
    const target = sync.provider("device-a");
    const remote = sync.provider("device-b");
    const engine = new SyncEngine({ primary, target });
    const second = new SyncEngine({ primary: other, target: remote });
    try {
      await primary.write("keep.md", "synthetic anchor");
      await engine.syncOnce();
      await primary.writeBinary(path, a);
      expect((await engine.syncOnce()).pushed).toEqual([path]);
      await second.syncOnce();
      expect(await bytes(other)).toEqual(a);
      await other.writeBinary(path, b);
      await second.syncOnce();
      const resumed = new SyncEngine({ primary, target });
      expect((await resumed.syncOnce()).pulled).toEqual([path]);
      expect(await bytes(primary)).toEqual(b);
      await primary.delete(path);
      await resumed.syncOnce();
      await second.syncOnce();
      expect(await bytes(other)).toBeUndefined();
      expect(await bytes(target)).toBeUndefined();
    } finally {
      await engine.stop();
      await second.stop();
      await sync.close();
    }
  });

  it("uses identical winner and conflict-copy names in either direction on an mtime tie", async () => {
    const run = async (ours: Uint8Array, theirs: Uint8Array) => {
      const primary = new MemoryStorageProvider({ id: "a", now: () => 100 });
      const target = new MemoryStorageProvider({ id: "b", now: () => 100 });
      await primary.writeBinary(path, ours);
      await target.writeBinary(path, theirs);
      const engine = new SyncEngine({ primary, target });
      const report = await engine.syncOnce();
      expect(report.conflicts).toHaveLength(1);
      const conflict = report.conflicts[0]!.conflictPath;
      expect(await bytes(primary)).toEqual(await bytes(target));
      expect(await bytes(primary, conflict)).toEqual(await bytes(target, conflict));
      expect(
        new Set([
          Array.from((await bytes(primary))!).join(),
          Array.from((await bytes(primary, conflict))!).join(),
        ]),
      ).toEqual(new Set([Array.from(a).join(), Array.from(b).join()]));
      const resumed = new SyncEngine({ primary, target });
      expect((await resumed.syncOnce()).conflicts).toEqual([]);
      return { winner: await bytes(primary), conflict };
    };
    expect(await run(a, b)).toEqual(await run(b, a));
  });

  it("leaves both originals intact when preserving the remote conflict copy fails, then recovers", async () => {
    const primary = new MemoryStorageProvider({ id: "a", now: () => 200 });
    const target = new MemoryStorageProvider({ id: "b", now: () => 100 });
    await primary.writeBinary(path, a);
    await target.writeBinary(path, b);
    let rejectCopy = true;
    const failing = new Proxy(target, {
      get(object, property) {
        if (property === "writeBinary")
          return async (
            file: string,
            data: Uint8Array,
            options: Parameters<StorageProvider["writeBinary"]>[2],
          ) => {
            if (rejectCopy && file !== path) throw new StorageError("synthetic interrupted copy");
            return object.writeBinary(file, data, options);
          };
        const value: unknown = Reflect.get(object, property);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
    const engine = new SyncEngine({ primary, target: failing });
    await engine.syncOnce();
    expect(engine.status().lastError).toContain("synthetic interrupted copy");
    expect(await bytes(primary)).toEqual(a);
    expect(await bytes(target)).toEqual(b);
    const copy = `Assets/sample (conflict ${(await binaryDigest(b)).slice(0, 16)}).bin`;
    expect(await bytes(primary, copy)).toEqual(b);
    rejectCopy = false;
    const recovered = new SyncEngine({ primary, target });
    await recovered.syncOnce();
    expect(await bytes(target)).toEqual(a);
    expect(await bytes(target, copy)).toEqual(b);
    expect((await primary.list()).map((entry) => entry.path)).toEqual([copy, path]);
  });

  it("keeps oversized binary files pending and never overwrites the target", async () => {
    const primary = new MemoryStorageProvider({ id: "a" });
    const target = new MemoryStorageProvider({ id: "b" });
    await primary.write(path, "x".repeat(SYNC_LIMITS.fileBytes + 1));
    const engine = new SyncEngine({ primary, target });
    await engine.syncOnce();
    expect(engine.status().pendingChanges).toBe(1);
    expect(engine.status().lastError).toContain("exceeds");
    expect(await target.stat(path)).toBeNull();
  });

  it("yields binary authority to the lease holder without generating a conflict copy", async () => {
    const primary = new MemoryStorageProvider({ id: "a" });
    const target = new MemoryStorageProvider({ id: "b" });
    await primary.writeBinary(path, a);
    await target.writeBinary(path, b);
    const engine = new SyncEngine({
      primary,
      target,
      fence: { covers: () => true, epoch: () => null },
    });
    const report = await engine.syncOnce();
    expect(report.conflicts).toEqual([]);
    expect(await bytes(primary)).toEqual(b);
    expect((await primary.list()).map((entry) => entry.path)).toEqual([path]);
  });
});

it("preserves every original byte for arbitrary concurrent binary edits", async () => {
  const { fc } = await import("@fast-check/vitest");
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ maxLength: 256 }),
      fc.uint8Array({ maxLength: 256 }),
      async (ours, theirs) => {
        const primary = new MemoryStorageProvider({ id: "a", now: () => 100 });
        const target = new MemoryStorageProvider({ id: "b", now: () => 100 });
        await primary.writeBinary(path, ours);
        await target.writeBinary(path, theirs);
        const engine = new SyncEngine({ primary, target });
        const report = await engine.syncOnce();
        expect(engine.status().pendingChanges).toBe(0);
        const results = [await bytes(primary)];
        for (const conflict of report.conflicts)
          results.push(await bytes(primary, conflict.conflictPath));
        expect(results.some((value) => value && Buffer.from(value).equals(Buffer.from(ours)))).toBe(
          true,
        );
        expect(
          results.some((value) => value && Buffer.from(value).equals(Buffer.from(theirs))),
        ).toBe(true);
        for (const entry of await primary.list())
          expect(await bytes(primary, entry.path)).toEqual(await bytes(target, entry.path));
      },
    ),
  );
});
