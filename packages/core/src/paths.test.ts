import { describe, expect, it } from "vitest";
import {
  ancestorFolders,
  basename,
  dirname,
  extname,
  InvalidPathError,
  isHiddenPath,
  isSafeVaultPath,
  isSidecarPath,
  normalizePath,
  stem,
} from "./paths";
import { mergeSettings } from "./settings";
import { diceSimilarity, hashString, isPrefixExtension } from "./text";

describe("vault paths", () => {
  it("normalizes separators and dot segments", () => {
    expect(normalizePath("/Daily//2026-09-23.md")).toBe("Daily/2026-09-23.md");
    expect(normalizePath("a\\b\\..\\c.md")).toBe("a/c.md");
    expect(normalizePath("./a/./b/")).toBe("a/b");
  });

  it("refuses to escape the vault", () => {
    expect(() => normalizePath("../etc/passwd")).toThrow(InvalidPathError);
    expect(() => normalizePath("a/../../b")).toThrow(InvalidPathError);
    expect(isSafeVaultPath("a/../../b")).toBe(false);
    expect(isSafeVaultPath("")).toBe(false);
    expect(isSafeVaultPath("Daily/x.md")).toBe(true);
  });

  it("splits paths", () => {
    expect(dirname("a/b/c.md")).toBe("a/b");
    expect(dirname("c.md")).toBe("");
    expect(basename("a/b/c.md")).toBe("c.md");
    expect(extname("a/b/c.MD")).toBe(".MD");
    expect(extname(".env")).toBe("");
    expect(stem("Daily/2026-09-23.md")).toBe("2026-09-23");
    expect(ancestorFolders("a/b/c.md")).toEqual(["a", "a/b"]);
  });

  it("classifies hidden and sidecar paths", () => {
    expect(isHiddenPath(".obsidian/app.json")).toBe(true);
    expect(isHiddenPath("Daily/.draft.md")).toBe(true);
    expect(isHiddenPath("Daily/x.md")).toBe(false);
    expect(isSidecarPath(".daily-do-list/threads/x.json")).toBe(true);
  });
});

describe("text helpers", () => {
  it("scores similarity", () => {
    expect(diceSimilarity("book dentist", "Book  Dentist")).toBe(1);
    expect(diceSimilarity("book dentist", "book the dentist")).toBeGreaterThan(0.7);
    expect(diceSimilarity("book dentist", "water plants")).toBeLessThan(0.3);
  });

  it("detects prefix extensions", () => {
    expect(isPrefixExtension("Book den", "book dentist appt")).toBe(true);
    expect(isPrefixExtension("Bo", "Book")).toBe(false);
  });

  it("hashes deterministically", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
    expect(hashString("hello")).not.toBe(hashString("hello!"));
  });
});

describe("mergeSettings", () => {
  it("deep merges known keys and ignores unknown ones", () => {
    const base = { a: 1, nested: { b: 2, c: 3 }, list: [1, 2] };
    const merged = mergeSettings(base, { nested: { b: 5 }, list: [9] } as never);
    expect(merged).toEqual({ a: 1, nested: { b: 5, c: 3 }, list: [9] });
    expect(mergeSettings(base, { zzz: 1 } as never)).toEqual(base);
  });
});
