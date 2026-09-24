import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { isBinaryPath, isMergeablePath, toStorableText, utf8ByteLength } from "./file-types";
import {
  ALWAYS_IGNORED_NAMES,
  IgnoreRules,
  isEditorTempName,
  isStorageTempPath,
} from "./ignore-rules";

const textArb = fc.oneof(
  fc.string({ unit: "binary", maxLength: 40 }),
  fc
    .array(
      fc.constantFrom("a", "é", "日", "🎉", "\uD800", "\uDFFF", "\uD83D\uDE00", "\r\n", "\0"),
      { maxLength: 12 },
    )
    .map((parts) => parts.join("")),
);

describe("text as a UTF-8 file stores it", () => {
  test.prop([textArb])("utf8ByteLength matches the platform encoder", (text) => {
    expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength);
  });

  test.prop([textArb])("toStorableText is exactly what a UTF-8 round trip yields", (text) => {
    const stored = toStorableText(text);
    expect(stored).toBe(new TextDecoder().decode(new TextEncoder().encode(text)));
    expect(toStorableText(stored)).toBe(stored);
    expect(stored.length).toBe(text.length);
  });

  test.prop([fc.string({ unit: "grapheme", maxLength: 40 })])(
    "leaves well-formed text alone",
    (text) => {
      expect(toStorableText(text)).toBe(text);
    },
  );
});

describe("file kinds", () => {
  it.each([
    ["photo.PNG", true, false],
    ["doc.pdf", true, false],
    ["note.md", false, true],
    ["NOTE.MARKDOWN", false, true],
    ["todo.txt", false, true],
    ["board.canvas", false, false],
    ["data.json", false, false],
    [".env", false, false],
    ["archive.tar.gz", true, false],
  ])("%s: binary %s, mergeable %s", (path, binary, mergeable) => {
    expect(isBinaryPath(path)).toBe(binary);
    expect(isMergeablePath(path)).toBe(mergeable);
    expect(isBinaryPath(`Some/Folder/${path}`)).toBe(binary);
  });
});

describe("IgnoreRules", () => {
  const segmentArb = fc.constantFrom(
    "Notes",
    "a.md",
    ".obsidian",
    ...ALWAYS_IGNORED_NAMES,
    "a.md~",
    ".a.md.swp",
    ".#lock",
    "4913",
    "x.crswap",
    "a.md___jb_tmp___",
    "note.sb-1a2b3c-XyZ",
    ".sync.tmp",
    ".ddl-tmp-abc123",
    "git",
    ".gitignore",
  );
  const pathArb = fc.array(segmentArb, { minLength: 1, maxLength: 4 }).map((s) => s.join("/"));

  test.prop([
    pathArb,
    fc.array(fc.constantFrom("Private", "Private/Drafts", "Notes/a.md", "/Archive/"), {
      maxLength: 2,
    }),
  ])("ignores junk anywhere, temp files by name, and configured prefixes", (path, prefixes) => {
    const segments = path.split("/");
    const name = segments.at(-1)!;
    const underPrefix = prefixes
      .map((p) => p.replace(/^\/|\/$/g, ""))
      .some((p) => path === p || path.startsWith(`${p}/`));
    const expected =
      segments.some((s) => ALWAYS_IGNORED_NAMES.has(s)) ||
      isStorageTempPath(path) ||
      isEditorTempName(name) ||
      underPrefix;
    expect(new IgnoreRules(prefixes).isIgnored(path)).toBe(expected);
  });

  it("does not mistake look-alikes for junk", () => {
    const rules = new IgnoreRules();
    for (const path of [
      ".gitignore",
      "git/notes.md",
      "Trash/a.md",
      "node_modules.md",
      "notes~draft.md",
    ]) {
      expect(rules.isIgnored(path), path).toBe(false);
    }
  });
});
