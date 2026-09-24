import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { parseWikiLinks, resolveWikiLink } from "./wikilinks";

const partChar = (forbidden: string) =>
  fc
    .oneof(
      fc.constantFrom(
        "a",
        "B",
        "z",
        "0",
        "9",
        " ",
        "-",
        "_",
        ".",
        "/",
        "(",
        "é",
        "日",
        "🎉",
        "[",
        "^",
        "!",
        "|",
        "#",
      ),
      fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 }),
    )
    .filter((ch) => ![...forbidden].some((f) => ch.includes(f)));
const partArb = (forbidden: string, minLength = 1) =>
  fc.array(partChar(forbidden), { minLength, maxLength: 12 }).map((chars) => chars.join(""));

const linkArb = fc
  .record({
    embed: fc.boolean(),
    target: partArb("]|#\n").filter(
      (t) => t.trim() !== "" && !t.endsWith("[") && !t.includes("[["),
    ),
    subpath: fc.option(
      partArb("]|\n").filter((s) => s.trim() !== ""),
      { nil: undefined },
    ),
    alias: fc.option(
      partArb("]\n").filter((s) => s.trim() !== ""),
      { nil: undefined },
    ),
  })
  .map((parts) => ({
    ...parts,
    source: `${parts.embed ? "!" : ""}[[${parts.target}${parts.subpath === undefined ? "" : `#${parts.subpath}`}${parts.alias === undefined ? "" : `|${parts.alias}`}]]`,
  }));
const proseArb = partArb("[]!\n", 0);

describe("parseWikiLinks", () => {
  test.prop([proseArb, linkArb, proseArb])(
    "parses a link built from parts back into them",
    (before, link, after) => {
      const text = `${before}${link.source}${after}`;
      const [parsed, ...rest] = parseWikiLinks(text);
      expect(rest).toEqual([]);
      expect(parsed).toEqual({
        target: link.target.trim(),
        embed: link.embed,
        from: before.length,
        to: before.length + link.source.length,
        ...(link.subpath === undefined ? {} : { subpath: link.subpath.trim() }),
        ...(link.alias === undefined ? {} : { alias: link.alias.trim() }),
      });
    },
  );

  test.prop([fc.array(fc.tuple(proseArb, linkArb), { maxLength: 5 })])(
    "finds every link in order without overlaps",
    (pieces) => {
      const text = pieces.map(([prose, link]) => `${prose}${link.source}`).join(" ");
      const links = parseWikiLinks(text);
      expect(links.map((l) => text.slice(l.from, l.to))).toEqual(
        pieces.map(([, link]) => link.source),
      );
    },
  );

  test.prop([fc.string({ unit: "binary", maxLength: 200 })])(
    "never throws and reports well-formed spans",
    (text) => {
      let previousEnd = 0;
      for (const link of parseWikiLinks(text)) {
        const source = text.slice(link.from, link.to);
        expect(source).toMatch(/^!?\[\[[\s\S]*]]$/);
        expect(link.embed).toBe(source.startsWith("!"));
        expect(link.from).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = link.to;
        expect(link.target).toBe(link.target.trim());
        expect(link.target).not.toBe("");
        expect(link.target).not.toMatch(/[\]|#\n]/);
      }
    },
  );

  it.each([
    ["[[Daily/2026-09-24]]", { target: "Daily/2026-09-24" }],
    ["[[Note#Heading]]", { target: "Note", subpath: "Heading" }],
    ["[[Note#^block-id]]", { target: "Note", subpath: "^block-id" }],
    ["[[Note#A#B|shown]]", { target: "Note", subpath: "A#B", alias: "shown" }],
    ["[[Note|a|b]]", { target: "Note", alias: "a|b" }],
    ["![[photo.png|300]]", { target: "photo.png", alias: "300", embed: true }],
    ["[[ spaced  ]]", { target: "spaced" }],
    ["[[a[b]]]", { target: "a[b" }],
    ["[[日記/2026年]]", { target: "日記/2026年" }],
  ])("%j", (text, expected) => {
    expect(parseWikiLinks(text)).toEqual([expect.objectContaining({ embed: false, ...expected })]);
  });

  it.each([
    ["[[]]"],
    ["[[ ]]"],
    ["[[#Heading only]]"],
    ["[[|alias only]]"],
    ["[[unclosed"],
    ["[[multi\nline]]"],
  ])("%j is not a link to a note", (text) => {
    expect(parseWikiLinks(text)).toEqual([]);
  });
});

describe("resolveWikiLink", () => {
  /** Obsidian-like reference: exact vault path first, then the shortest path ending in it. */
  function oracle(target: string, paths: readonly string[]): string | null {
    const wanted = target.replace(/\\/g, "/").replace(/^\//, "").toLowerCase();
    const base = wanted.slice(wanted.lastIndexOf("/") + 1);
    const hasExtension = base.lastIndexOf(".") > 0;
    const names = wanted.endsWith(".md")
      ? [wanted]
      : hasExtension
        ? [`${wanted}.md`, wanted]
        : [`${wanted}.md`];
    const exact = paths.find((p) => names.includes(p.toLowerCase()));
    if (exact !== undefined) return exact;
    let best: string | null = null;
    for (const p of paths) {
      if (!names.some((n) => p.toLowerCase().endsWith(`/${n}`))) continue;
      if (best === null || p.length < best.length) best = p;
    }
    return best;
  }

  const pathArb = fc
    .tuple(
      fc.constantFrom("", "Daily/", "Archive/", "Projects/Work/", "archive/Old/", "Daily/Archive/"),
      fc.constantFrom(
        "Plan",
        "plan",
        "2026-09-24",
        "v1.2 notes",
        "v1",
        "image",
        "Meeting 2026.09.23",
        "日記",
      ),
      fc.constantFrom(".md", ".MD", ".png", ".md.bak", ""),
    )
    .map(([folder, name, ext]) => `${folder}${name}${ext}`);
  const targetArb = fc
    .tuple(
      fc.constantFrom("", "Daily/", "Archive/", "Work/", "/", "archive/old/"),
      fc.constantFrom(
        "Plan",
        "PLAN",
        "2026-09-24",
        "v1.2 notes",
        "v1",
        "image.png",
        "Meeting 2026.09.23",
        "日記",
        "Plan.md",
      ),
    )
    .map(([folder, name]) => `${folder}${name}`);

  test.prop([targetArb, fc.uniqueArray(pathArb, { maxLength: 12 })])(
    "agrees with the reference resolver",
    (target, paths) => {
      expect(resolveWikiLink(target, paths)).toBe(oracle(target, paths));
    },
  );

  it("prefers an exact path, then the shortest path that ends with the target", () => {
    const paths = ["Archive/Daily/2026-09-24.md", "Daily/2026-09-24.md", "2026-09-24.md"];
    expect(resolveWikiLink("Daily/2026-09-24", paths)).toBe("Daily/2026-09-24.md");
    expect(resolveWikiLink("2026-09-24", paths)).toBe("2026-09-24.md");
    expect(resolveWikiLink("daily/2026-09-24", ["Archive/Daily/2026-09-24.md"])).toBe(
      "Archive/Daily/2026-09-24.md",
    );
  });

  it("ignores Unicode normalization, like the disk does on macOS", () => {
    expect(resolveWikiLink("Caf\u00e9", ["Notes/Cafe\u0301.md"])).toBe("Notes/Cafe\u0301.md");
    expect(resolveWikiLink("Cafe\u0301/Menu", ["Caf\u00e9/Menu.md"])).toBe("Caf\u00e9/Menu.md");
  });

  it("does not resolve a folder-qualified link to a namesake in another folder", () => {
    expect(resolveWikiLink("Projects/Plan", ["Archive/Plan.md"])).toBeNull();
  });

  it("treats dots in note names as part of the name, and links to attachments by full name", () => {
    expect(resolveWikiLink("v1.2 notes", ["v1.md"])).toBeNull();
    expect(resolveWikiLink("v1.2 notes", ["Archive/v1.2 notes.md", "v1.md"])).toBe(
      "Archive/v1.2 notes.md",
    );
    expect(resolveWikiLink("image.png", ["image.md", "Attachments/image.png"])).toBe(
      "Attachments/image.png",
    );
  });
});
