import { describe, expect, it } from "vitest";
import { MemoryStorageProvider } from "./memory";
import { searchVault } from "./search";

function vault(files: Record<string, string>, clock = { t: 1_000 }): MemoryStorageProvider {
  // Each file gets a later mtime than the previous one (insertion order = age order).
  return new MemoryStorageProvider({ initialFiles: files, now: () => clock.t++ });
}

describe("searchVault", () => {
  it("ranks file-name matches first, then matching lines (0-based)", async () => {
    const s = vault({
      "Projects/Garden.md": "Plan the beds\nOrder seeds",
      "Daily/2026-09-23.md": "- [ ] water the garden\n- [ ] call the bank",
    });
    expect(await searchVault(s, "garden")).toEqual([
      { path: "Projects/Garden.md", kind: "name", line: 0, preview: "Projects/Garden.md" },
      { path: "Daily/2026-09-23.md", kind: "content", line: 0, preview: "- [ ] water the garden" },
    ]);
  });

  it("is case-insensitive and ignores surrounding whitespace in the query", async () => {
    const s = vault({ "a.md": "Call MOM today" });
    expect(await searchVault(s, "  mom ")).toEqual([
      { path: "a.md", kind: "content", line: 0, preview: "Call MOM today" },
    ]);
  });

  it("matches whole paths when the query contains a slash", async () => {
    const s = vault({ "Daily/2026-09-23.md": "x", "Weekly/2026-W39.md": "daily review" });
    expect((await searchVault(s, "daily/2026")).map((h) => h.path)).toEqual([
      "Daily/2026-09-23.md",
    ]);
    expect((await searchVault(s, "daily")).map((h) => `${h.path}:${h.line}`)).toEqual([
      "Weekly/2026-W39.md:0",
    ]);
  });

  it("searches recently modified notes first and stops at the limit", async () => {
    const s = vault({ "old.md": "task\ntask", "new.md": "task\ntask\ntask" });
    const hits = await searchVault(s, "task", { limit: 4 });
    expect(hits.map((h) => `${h.path}:${h.line}`)).toEqual([
      "new.md:0",
      "new.md:1",
      "new.md:2",
      "old.md:0",
    ]);
  });

  it("skips hidden notes unless asked, non-markdown files and oversized files", async () => {
    const s = vault({
      ".daily-do-list/notes.md": "needle",
      "data.json": '{"needle": true}',
      "big.md": `needle ${"x".repeat(2_000)}`,
      "small.md": "needle",
    });
    expect((await searchVault(s, "needle", { maxFileBytes: 1_000 })).map((h) => h.path)).toEqual([
      "small.md",
    ]);
    expect(
      (await searchVault(s, "needle", { includeHidden: true, maxFileBytes: 1_000 }))
        .map((h) => h.path)
        .sort(),
    ).toEqual([".daily-do-list/notes.md", "small.md"]);
  });

  it("trims long lines to a preview centred on the match", async () => {
    const line = `${"a".repeat(300)} NEEDLE ${"b".repeat(300)}`;
    const [hit] = await searchVault(vault({ "long.md": line }), "needle");
    expect(hit?.preview.startsWith("…")).toBe(true);
    expect(hit?.preview.endsWith("…")).toBe(true);
    expect(hit?.preview).toContain("NEEDLE");
    expect(hit?.preview.length).toBeLessThanOrEqual(162);
    const [start] = await searchVault(vault({ "start.md": `NEEDLE ${"c".repeat(400)}` }), "needle");
    expect(start?.preview.startsWith("NEEDLE")).toBe(true);
    expect(start?.preview.endsWith("…")).toBe(true);
  });

  it("requires every term to appear in the name or on the same line", async () => {
    const s = vault({
      "a.md": "- [ ] Book flights to Lisbon\n- [ ] book dentist\nLisbon notes",
      "Lisbon trip.md": "packing list",
    });
    expect(await searchVault(s, "book lisbon")).toEqual([
      { path: "a.md", kind: "content", line: 0, preview: "- [ ] Book flights to Lisbon" },
    ]);
    expect((await searchVault(s, "lisbon trip")).map((h) => `${h.kind}:${h.path}`)).toEqual([
      "name:Lisbon trip.md",
    ]);
  });

  it("returns nothing for an empty query", async () => {
    expect(await searchVault(vault({ "a.md": "anything" }), "   ")).toEqual([]);
  });

  it("reports one hit per line, with CRLF line endings stripped from previews", async () => {
    const s = vault({ "a.md": "first\r\nneedle and needle\r\nlast needle" });
    expect(await searchVault(s, "needle")).toEqual([
      { path: "a.md", kind: "content", line: 1, preview: "needle and needle" },
      { path: "a.md", kind: "content", line: 2, preview: "last needle" },
    ]);
  });

  it("finds matches in text whose lowercase form changes length", async () => {
    const s = vault({ "a.md": "İstanbul trip\nbook the ferry" });
    expect(await searchVault(s, "ferry")).toEqual([
      { path: "a.md", kind: "content", line: 1, preview: "book the ferry" },
    ]);
  });

  it("sees edits, new notes and deletions after earlier searches", async () => {
    const s = vault({ "a.md": "alpha" });
    expect(await searchVault(s, "alpha")).toHaveLength(1);
    await s.write("a.md", "beta");
    await s.write("b.md", "alpha again");
    expect(await searchVault(s, "alpha")).toEqual([
      { path: "b.md", kind: "content", line: 0, preview: "alpha again" },
    ]);
    await s.delete("b.md");
    expect(await searchVault(s, "alpha")).toEqual([]);
    expect(await searchVault(s, "beta")).toEqual([
      { path: "a.md", kind: "content", line: 0, preview: "beta" },
    ]);
  });

  it("only reads notes that changed since the last search", async () => {
    const s = vault({ "a.md": "alpha", "b.md": "beta" });
    await searchVault(s, "warm");
    const reads: string[] = [];
    const counting = new Proxy(s, {
      get(target, prop, receiver) {
        if (prop === "read") {
          return (path: string) => {
            reads.push(path);
            return target.read(path);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // A proxy is a different cache key, so warm it first.
    await searchVault(counting, "warm");
    reads.length = 0;
    await searchVault(counting, "alpha");
    expect(reads).toEqual([]);
    await s.write("b.md", "beta changed");
    await searchVault(counting, "alpha");
    expect(reads).toEqual(["b.md"]);
  });
});
