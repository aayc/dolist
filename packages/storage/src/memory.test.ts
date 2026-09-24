import { describe, expect, it } from "vitest";
import { describeStorageContract } from "./contract-suite";
import { MemoryStorageProvider } from "./memory";
import { ConflictError, NotFoundError, type StorageEvent } from "./types";

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
