import { describe, expect, it } from "vitest";
import {
  decodePersistedImportManifest,
  encodePersistedImportManifest,
  type PersistedImportManifest,
} from "../../src/persisted";
import { readFixture } from "./fixtures";

const HASH = "6a09e667f3bcc908b2fb1366ea957d3e3adec17512775099da6f1bd0f3e0f2f1";

describe("import manifest", () => {
  it("loads the golden file with every entry", () => {
    const result = decodePersistedImportManifest(readFixture("import-manifest", "v1.json"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe("/Users/me/Obsidian/Notebook");
    expect(result.value.updatedAt).toBe(1790086400000);
    expect([...result.value.files.keys()]).toEqual([
      ".obsidian/app.json",
      "Daily/2026-09-24.md",
      "Journal/Café ☕/première note.md",
    ]);
    expect(result.value.files.get("Daily/2026-09-24.md")?.base).toMatch(/^3c6ef372/);
  });

  it("drops invalid entries one by one and says where", () => {
    const result = decodePersistedImportManifest(
      readFixture("import-manifest", "v1-invalid-entries.json"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.files.keys()]).toEqual(["ok.md"]);
    expect(result.issues.map((issue) => issue.path).sort()).toEqual([
      "files.negative-size.md",
      "files.not-an-object.md",
      "files.short-hash.md",
    ]);
  });

  it("refuses a file without version: the format was versioned from the start", () => {
    expect(
      decodePersistedImportManifest(readFixture("import-manifest", "corrupt-missing-version.json")),
    ).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("round-trips, sorted by path, with any path as a key", () => {
    const manifest: PersistedImportManifest = {
      source: "/Volumes/Notes/Vault",
      importedAt: 1,
      files: new Map([
        ["z.md", { sha256: HASH, size: 1, mtimeMs: 2 }],
        ["__proto__", { sha256: HASH, size: 3, mtimeMs: 4, base: HASH }],
        ["a/b.md", { sha256: HASH, size: 5, mtimeMs: 6 }],
      ]),
    };
    const text = encodePersistedImportManifest(manifest);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text).files)).toEqual(["__proto__", "a/b.md", "z.md"]);
    const decoded = decodePersistedImportManifest(text);
    expect(decoded.ok && decoded.value).toEqual(manifest);
  });
});
