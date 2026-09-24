import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  ancestorFolders,
  basename,
  compareVaultPaths,
  dirname,
  ensureMarkdownExtension,
  extname,
  InvalidPathError,
  isHiddenPath,
  isMarkdownPath,
  isSafeVaultPath,
  isSidecarPath,
  joinPath,
  normalizePath,
  SIDECAR_DIR,
  stem,
} from "./paths";

/** Reference normalization: split on both separators, drop empty/`.`, resolve `..` on a stack. */
function oracleNormalize(input: string): string | "escape" | "nul" {
  if (input.includes("\0")) return "nul";
  const stack: string[] = [];
  for (const segment of input.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return "escape";
      stack.pop();
    } else stack.push(segment);
  }
  return stack.join("/");
}

const segmentArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      "Daily",
      "notes",
      "a",
      "B",
      "2026-09-23.md",
      "Café",
      "日記",
      "my note.md",
      "x.tar.gz",
    ),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "",
      ".",
      "..",
      "...",
      ". ",
      " ..",
      ".hidden",
      SIDECAR_DIR,
      ".md",
      "a.",
    ),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom("a\\b", "..\\..", "%2e%2e", "\0", "🎉", "a b", "\u2028"),
  },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 6 }) },
);
const rawPathArb = fc
  .tuple(fc.array(segmentArb, { maxLength: 7 }), fc.constantFrom("/", "\\", "//"), fc.boolean())
  .map(([segments, sep, leading]) => `${leading ? sep : ""}${segments.join(sep)}`);
/** Paths already in canonical vault form. */
const vaultPathArb = rawPathArb
  .map(oracleNormalize)
  .filter((p): p is string => p !== "escape" && p !== "nul" && p !== "");

describe("normalizePath", () => {
  test.prop([rawPathArb])(
    "matches the reference normalization, throwing only on escapes and NUL",
    (input) => {
      const expected = oracleNormalize(input);
      if (expected === "escape" || expected === "nul") {
        expect(() => normalizePath(input)).toThrow(InvalidPathError);
        expect(isSafeVaultPath(input)).toBe(false);
        return;
      }
      expect(normalizePath(input)).toBe(expected);
      expect(isSafeVaultPath(input)).toBe(expected !== "");
    },
  );

  test.prop([rawPathArb])("is idempotent and produces canonical, contained paths", (input) => {
    fc.pre(
      typeof oracleNormalize(input) === "string" &&
        !["escape", "nul"].includes(oracleNormalize(input)),
    );
    const p = normalizePath(input);
    expect(normalizePath(p)).toBe(p);
    expect(p.startsWith("/")).toBe(false);
    expect(p.endsWith("/")).toBe(false);
    expect(p).not.toContain("\\");
    if (p) for (const segment of p.split("/")) expect(["", ".", ".."]).not.toContain(segment);
  });

  it.each([
    ["../x", "escape"],
    ["a/../../x", "escape"],
    ["a\\..\\..\\x", "escape"],
    ["a/b/../../..", "escape"],
    ["a/b/../..", ""],
    ["%2e%2e/x", "%2e%2e/x"],
    ["... /x", "... /x"],
  ])("%j → %j", (input, expected) => {
    if (expected === "escape") expect(() => normalizePath(input)).toThrow(InvalidPathError);
    else expect(normalizePath(input)).toBe(expected);
  });
});

describe("path helpers", () => {
  test.prop([vaultPathArb])("dirname, basename and joinPath recompose the path", (p) => {
    expect(joinPath(dirname(p), basename(p))).toBe(p);
    expect(basename(p)).not.toContain("/");
    expect(p.startsWith(dirname(p))).toBe(true);
    expect(dirname(p) === "" ? p : p.slice(dirname(p).length + 1)).toBe(basename(p));
  });

  test.prop([vaultPathArb])(
    "stem + extname is the base name; extensions start at the last dot",
    (p) => {
      const ext = extname(p);
      expect(stem(p) + ext).toBe(basename(p));
      if (ext) {
        expect(ext.startsWith(".")).toBe(true);
        expect(ext.slice(1)).not.toContain(".");
        expect(stem(p)).not.toBe("");
      }
      expect(isMarkdownPath(p)).toBe(ext.toLowerCase() === ".md");
      const md = ensureMarkdownExtension(p);
      expect(isMarkdownPath(md)).toBe(true);
      expect(ensureMarkdownExtension(md)).toBe(md);
    },
  );

  test.prop([vaultPathArb])("hidden and sidecar classification", (p) => {
    const hidden = p.split("/").some((s) => s.startsWith("."));
    expect(isHiddenPath(p)).toBe(hidden);
    expect(isSidecarPath(p)).toBe(p === SIDECAR_DIR || p.startsWith(`${SIDECAR_DIR}/`));
    if (isSidecarPath(p)) expect(isHiddenPath(p)).toBe(true);
    expect(isSidecarPath(`${SIDECAR_DIR}x/${p}`)).toBe(false);
  });

  test.prop([vaultPathArb])(
    "ancestorFolders lists every proper prefix folder, outermost first",
    (p) => {
      const ancestors = ancestorFolders(p);
      expect(ancestors).toHaveLength(p.split("/").length - 1);
      ancestors.forEach((folder, i) => {
        expect(p.startsWith(`${folder}/`)).toBe(true);
        if (i > 0) expect(dirname(folder)).toBe(ancestors[i - 1]);
      });
      if (ancestors.length > 0) expect(ancestors.at(-1)).toBe(dirname(p));
    },
  );

  it("treats dotfiles as extensionless and a trailing dot as an empty extension", () => {
    expect([extname(".env"), stem(".env")]).toEqual(["", ".env"]);
    expect([extname("a."), stem("a.")]).toEqual([".", "a"]);
    expect([extname("x.tar.gz"), stem("x.tar.gz")]).toEqual([".gz", "x.tar"]);
  });
});

describe("compareVaultPaths", () => {
  const nameArb = fc.oneof(
    fc.string({
      unit: fc.constantFrom("a", "B", "é", "E", "1", "2", "0", " ", "-", ".", "/", "日"),
      maxLength: 8,
    }),
    fc.integer({ min: 0, max: 200 }).map((n) => `note ${n}.md`),
  );

  test.prop([nameArb, nameArb, nameArb])("is a consistent total preorder", (a, b, c) => {
    expect(compareVaultPaths(a, a)).toBe(0);
    expect(Math.sign(compareVaultPaths(a, b)) + Math.sign(compareVaultPaths(b, a))).toBe(0);
    if (compareVaultPaths(a, b) <= 0 && compareVaultPaths(b, c) <= 0) {
      expect(compareVaultPaths(a, c)).toBeLessThanOrEqual(0);
    }
  });

  test.prop([fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 10_000 })])(
    "orders embedded numbers numerically",
    (x, y) => {
      expect(Math.sign(compareVaultPaths(`Day ${x}.md`, `Day ${y}.md`))).toBe(Math.sign(x - y));
    },
  );

  it("ignores case and accents, so equal names need a tie-breaker for a stable order", () => {
    expect(compareVaultPaths("notes.md", "Notes.md")).toBe(0);
    expect(compareVaultPaths("cafe.md", "café.md")).toBe(0);
  });
});
