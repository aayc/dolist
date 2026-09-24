import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { markdownSupport } from "./language";
import { splitWikiLink } from "./markdown-extensions";

function nodes(doc: string, ...names: string[]): Array<[string, string]> {
  const state = EditorState.create({ doc, extensions: [markdownSupport] });
  const tree = ensureSyntaxTree(state, doc.length, 5000);
  if (!tree) throw new Error("parse timed out");
  const out: Array<[string, string]> = [];
  tree.iterate({
    enter(node) {
      if (names.includes(node.name)) out.push([node.name, doc.slice(node.from, node.to)]);
    },
  });
  return out;
}

const WIKI_PARTS = ["WikiLink", "WikiLinkMark", "WikiLinkTarget", "WikiLinkAlias"];

describe("wikilink syntax", () => {
  it("parses a plain wikilink instead of a bracketed link", () => {
    expect(nodes("see [[Daily/2026-06-19]] now", ...WIKI_PARTS, "Link")).toEqual([
      ["WikiLink", "[[Daily/2026-06-19]]"],
      ["WikiLinkMark", "[["],
      ["WikiLinkTarget", "Daily/2026-06-19"],
      ["WikiLinkMark", "]]"],
    ]);
  });

  it("parses aliases and heading targets", () => {
    expect(nodes("[[Note#Plan|the plan]]", ...WIKI_PARTS)).toEqual([
      ["WikiLink", "[[Note#Plan|the plan]]"],
      ["WikiLinkMark", "[["],
      ["WikiLinkTarget", "Note#Plan"],
      ["WikiLinkMark", "|"],
      ["WikiLinkAlias", "the plan"],
      ["WikiLinkMark", "]]"],
    ]);
  });

  it("parses embeds and several links on one line", () => {
    expect(nodes("![[diagram.png]] and [[A]] [[B]]", "WikiLink")).toEqual([
      ["WikiLink", "![[diagram.png]]"],
      ["WikiLink", "[[A]]"],
      ["WikiLink", "[[B]]"],
    ]);
  });

  it("rejects malformed links", () => {
    for (const doc of ["[[]]", "[[a]b]]", "[[unclosed", "[[|alias]]", "[[a\nb]]", "[[a [b]]"]) {
      expect(nodes(doc, "WikiLink"), doc).toEqual([]);
    }
  });

  it("ignores wikilinks inside code", () => {
    expect(nodes("`[[Note]]`\n\n```\n[[Note]]\n```", "WikiLink")).toEqual([]);
  });

  it("works inside tasks, emphasis and headings", () => {
    expect(nodes("# [[H]]\n- [ ] call [[Sam]]\n*[[Em]]*", "WikiLinkTarget")).toEqual([
      ["WikiLinkTarget", "H"],
      ["WikiLinkTarget", "Sam"],
      ["WikiLinkTarget", "Em"],
    ]);
  });
});

describe("splitWikiLink", () => {
  it("splits target, subpath and alias", () => {
    expect(splitWikiLink("Note")).toEqual({ target: "Note" });
    expect(splitWikiLink("Note#Heading")).toEqual({ target: "Note", subpath: "Heading" });
    expect(splitWikiLink("Note#^block|alias")).toEqual({
      target: "Note",
      subpath: "^block",
      alias: "alias",
    });
    expect(splitWikiLink("#Local heading")).toEqual({ target: "", subpath: "Local heading" });
    expect(splitWikiLink(" Spaced | shown ")).toEqual({ target: "Spaced", alias: "shown" });
  });
});

describe("hashtag syntax", () => {
  it("parses tags at the start of inline content or after whitespace", () => {
    expect(nodes("#todo and #nested/tag-1 plus #日本語", "Hashtag")).toEqual([
      ["Hashtag", "#todo"],
      ["Hashtag", "#nested/tag-1"],
      ["Hashtag", "#日本語"],
    ]);
  });

  it("rejects numbers, mid-word hashes and heading marks", () => {
    expect(nodes("#123 a#b (#paren) # Heading", "Hashtag")).toEqual([]);
    expect(nodes("## Heading #tag", "Hashtag", "HeaderMark")).toEqual([
      ["HeaderMark", "##"],
      ["Hashtag", "#tag"],
    ]);
  });

  it("ignores tags in code and URL fragments", () => {
    expect(nodes("`#code` https://example.com/#frag", "Hashtag")).toEqual([]);
  });
});

describe("highlight syntax", () => {
  it("parses ==highlight== with marks", () => {
    expect(nodes("a ==marked== b", "Highlight", "HighlightMark")).toEqual([
      ["Highlight", "==marked=="],
      ["HighlightMark", "=="],
      ["HighlightMark", "=="],
    ]);
  });

  it("requires flanking delimiters", () => {
    expect(nodes("a == b == c", "Highlight")).toEqual([]);
    expect(nodes("===", "Highlight")).toEqual([]);
  });
});

describe("alternate task statuses", () => {
  it("parses [/], [-] and [>] as tasks like @ddl/core does", () => {
    expect(nodes("- [/] doing\n- [-] dropped\n- [>] later\n- [ ] open", "TaskMarker")).toEqual([
      ["TaskMarker", "[/]"],
      ["TaskMarker", "[-]"],
      ["TaskMarker", "[>]"],
      ["TaskMarker", "[ ]"],
    ]);
  });

  it("still requires a list item and whitespace after the box", () => {
    expect(nodes("[/] not in a list\n- [/]no space", "TaskMarker")).toEqual([]);
  });
});

describe("indented code", () => {
  it("is disabled so indented tasks stay tasks", () => {
    expect(nodes("\t- [ ] indented task\n\n    four spaces", "Task", "CodeBlock")).toEqual([
      ["Task", "[ ] indented task"],
    ]);
  });
});
