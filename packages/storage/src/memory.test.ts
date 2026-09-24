import { InvalidPathError } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { describeStorageContract } from "./contract-suite";
import { MemoryStorageProvider } from "./memory";
import { ConflictError, NotFoundError, StorageError, type StorageEvent } from "./types";

describeStorageContract("MemoryStorageProvider", () => ({ provider: new MemoryStorageProvider() }));

describe("MemoryStorageProvider (reference contract)", () => {
  it("writes, reads and versions content", async () => {
    const s = new MemoryStorageProvider();
    const w = await s.write("Daily/2026-09-23.md", "- [ ] hi");
    expect(w.created).toBe(true);
    const r = await s.read("Daily/2026-09-23.md");
    expect(r?.content).toBe("- [ ] hi");
    expect(r?.version).toBe(w.version);
    const w2 = await s.write("Daily/2026-09-23.md", "- [x] hi");
    expect(w2.created).toBe(false);
    expect(w2.version).not.toBe(w.version);
  });

  it("enforces optimistic concurrency", async () => {
    const s = new MemoryStorageProvider();
    const w = await s.write("a.md", "one");
    await expect(s.write("a.md", "two", { ifMatch: "stale" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(s.write("a.md", "two", { ifMatch: null })).rejects.toBeInstanceOf(ConflictError);
    await expect(s.write("a.md", "two", { ifMatch: w.version })).resolves.toMatchObject({
      created: false,
    });
    await expect(s.write("b.md", "new", { ifMatch: null })).resolves.toMatchObject({
      created: true,
    });
  });

  it("hides dot paths unless asked and filters by prefix", async () => {
    const s = new MemoryStorageProvider({
      initialFiles: { "a.md": "", "Daily/x.md": "", ".daily-do-list/threads/t.json": "{}" },
    });
    expect((await s.list()).map((f) => f.path)).toEqual(["Daily/x.md", "a.md"]);
    expect((await s.list({ includeHidden: true })).length).toBe(3);
    expect((await s.list({ prefix: "Daily" })).map((f) => f.path)).toEqual(["Daily/x.md"]);
    expect(await s.listFolders()).toEqual(["Daily"]);
  });

  it("reports the parents of created folders", async () => {
    const s = new MemoryStorageProvider();
    await s.createFolder("Projects/Active/Empty");
    expect(await s.listFolders()).toEqual(["Projects", "Projects/Active", "Projects/Active/Empty"]);
  });

  it("renames and deletes with events", async () => {
    const s = new MemoryStorageProvider();
    const events: StorageEvent[] = [];
    s.watch((e) => events.push(e));
    await s.write("a.md", "x");
    await s.rename("a.md", "b.md");
    await s.delete("b.md");
    await expect(s.delete("b.md")).rejects.toBeInstanceOf(NotFoundError);
    s.simulateExternalChange("c.md", "external");
    expect(events.map((e) => `${e.kind}:${e.path}:${e.self}`)).toEqual([
      "created:a.md:true",
      "deleted:a.md:true",
      "created:b.md:true",
      "deleted:b.md:true",
      "created:c.md:false",
    ]);
  });
});

// Regressions for divergences from LocalFsStorageProvider found by model-based.test.ts.
describe("MemoryStorageProvider behaves like a vault folder on disk", () => {
  it("rejects empty paths like any other invalid path", async () => {
    const s = new MemoryStorageProvider();
    for (const op of [
      () => s.read(""),
      () => s.stat("./"),
      () => s.write("/", "x"),
      () => s.delete(""),
      () => s.rename("", "a.md"),
      () => s.createFolder(""),
      () => s.deleteFolder(""),
    ]) {
      await expect(op()).rejects.toBeInstanceOf(InvalidPathError);
    }
    await expect(s.list({ prefix: "../x" })).rejects.toBeInstanceOf(InvalidPathError);
    await expect(s.listFolders({ prefix: "../x" })).rejects.toBeInstanceOf(InvalidPathError);
  });

  it("never lets a file and a folder share a path", async () => {
    const s = new MemoryStorageProvider({ initialFiles: { "file.md": "x" } });
    await s.createFolder("Dir");
    await expect(s.write("Dir", "x")).rejects.toThrow('Not a file: "Dir"');
    await expect(s.write("file.md/child.md", "x")).rejects.toBeInstanceOf(StorageError);
    await expect(s.createFolder("file.md")).rejects.toBeInstanceOf(StorageError);
    await expect(s.createFolder("file.md/sub")).rejects.toBeInstanceOf(StorageError);
    await expect(s.rename("file.md", "Dir")).rejects.toMatchObject({
      name: "ConflictError",
      currentVersion: null,
    });
    await expect(s.rename("file.md", "file.md/inside.md")).rejects.toBeInstanceOf(StorageError);
    await expect(s.deleteFolder("file.md")).rejects.toThrow("is not a folder");
    // A conditional write checks its precondition first, like the disk provider.
    await expect(s.write("file.md/child.md", "x", { ifMatch: "v1" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await s.list()).map((f) => f.path)).toEqual(["file.md"]);
  });

  it("keeps folders once they exist, even when emptied", async () => {
    const s = new MemoryStorageProvider();
    await s.write("Inbox/Sub/a.md", "a");
    await s.rename("Inbox/Sub/a.md", "Archive/a.md");
    await s.delete("Archive/a.md");
    expect(await s.listFolders()).toEqual(["Archive", "Inbox", "Inbox/Sub"]);
    await s.deleteFolder("Inbox");
    expect(await s.listFolders()).toEqual(["Archive"]);
  });

  it("never lists or reports junk and temp files, but still reads them", async () => {
    const s = new MemoryStorageProvider();
    const events: StorageEvent[] = [];
    s.watch((e) => events.push(e));
    for (const path of [
      ".trash/old.md",
      "node_modules/p/x.md",
      "Notes/a.md~",
      ".DS_Store",
      "Notes/.ddl-tmp-1",
    ]) {
      await s.write(path, "junk");
    }
    await s.write("Notes/a.md", "real");
    expect((await s.list({ includeHidden: true })).map((f) => f.path)).toEqual(["Notes/a.md"]);
    expect(await s.listFolders({ includeHidden: true })).toEqual(["Notes"]);
    expect(events.map((e) => e.path)).toEqual(["Notes/a.md"]);
    expect((await s.read(".trash/old.md"))?.content).toBe("junk");
  });

  it("reports a deleted folder's files in path order", async () => {
    const s = new MemoryStorageProvider();
    for (const path of ["P/z.md", "P/a.md", "P/m/b.md"]) await s.write(path, path);
    const events: string[] = [];
    s.watch((e) => events.push(e.path));
    await s.deleteFolder("P");
    expect(events).toEqual(["P/a.md", "P/m/b.md", "P/z.md"]);
  });

  it("stores what UTF-8 can hold: a lone surrogate becomes U+FFFD", async () => {
    const s = new MemoryStorageProvider();
    const w = await s.write("a.md", "half \uD83D emoji");
    expect((await s.read("a.md"))?.content).toBe("half \uFFFD emoji");
    expect((await s.read("a.md"))?.version).toBe(w.version);
  });
});
