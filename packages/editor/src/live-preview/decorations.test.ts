import type { Decoration } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { selectEmbedEffect } from "../embeds/layer";
import type { EmbedRenderer } from "../embeds/types";
import { EmbedWidget } from "../embeds/widget";
import type { HeadlessStateOptions } from "../extensions";
import { parsedState } from "../test-helpers";
import { buildLivePreviewDecorations, frontmatterEnd, type VisibleRange } from "./decorations";
import { CheckboxWidget } from "./widgets";

interface PreviewOptions extends HeadlessStateOptions {
  cursor?: number;
  focused?: boolean;
  ranges?: VisibleRange[];
}

interface Summary {
  hidden: string[];
  widgets: Array<[string, string]>;
  marks: Array<[string, string]>;
  lines: Array<[number, string]>;
  decorations: Array<{ from: number; to: number; deco: Decoration }>;
}

function preview(doc: string, options: PreviewOptions = {}): Summary {
  const { cursor, focused = true, ranges, ...stateOptions } = options;
  const state = parsedState(doc, {
    ...stateOptions,
    selection: { anchor: cursor ?? doc.length },
  });
  const set = buildLivePreviewDecorations(state, ranges ?? [{ from: 0, to: doc.length }], focused);
  const summary: Summary = { hidden: [], widgets: [], marks: [], lines: [], decorations: [] };
  set.between(0, doc.length, (from, to, deco) => {
    summary.decorations.push({ from, to, deco });
    const spec = deco.spec as { widget?: object; class?: string };
    if (spec.widget) summary.widgets.push([doc.slice(from, to), spec.widget.constructor.name]);
    else if (spec.class && from === to) {
      summary.lines.push([state.doc.lineAt(from).number, spec.class]);
    } else if (spec.class) summary.marks.push([spec.class, doc.slice(from, to)]);
    else summary.hidden.push(doc.slice(from, to));
  });
  return summary;
}

describe("live preview: headings", () => {
  const doc = "# Title\n\nbody";

  it("hides heading marks off the active line", () => {
    const s = preview(doc);
    expect(s.hidden).toEqual(["# "]);
    expect(s.lines).toContainEqual([1, "cm-ddl-heading cm-ddl-h1"]);
  });

  it("reveals them when the caret is on the heading line", () => {
    const s = preview(doc, { cursor: 4 });
    expect(s.hidden).toEqual([]);
    expect(s.lines).toContainEqual([1, "cm-ddl-heading cm-ddl-h1"]);
  });

  it("renders everything when the editor is not focused", () => {
    expect(preview(doc, { cursor: 4, focused: false }).hidden).toEqual(["# "]);
  });

  it("hides closing sequences and styles every level", () => {
    const s = preview("### Three ###\n###### Six\n\nx");
    expect(s.hidden).toEqual(["### ", " ###", "###### "]);
    expect(s.lines).toEqual([
      [1, "cm-ddl-heading cm-ddl-h3"],
      [2, "cm-ddl-heading cm-ddl-h6"],
    ]);
  });
});

describe("live preview: inline syntax", () => {
  const doc = "a **bold** and *it* here";

  it("hides marks while the selection is elsewhere on the line", () => {
    expect(preview(doc, { cursor: 0 }).hidden).toEqual(["**", "**", "*", "*"]);
  });

  it("reveals only the element the caret touches", () => {
    expect(preview(doc, { cursor: 5 }).hidden).toEqual(["*", "*"]);
    expect(preview(doc, { cursor: 10 }).hidden).toEqual(["*", "*"]);
  });

  it("handles strikethrough, highlight, inline code and escapes", () => {
    const s = preview("~~old~~ ==hl== `code` \\*lit\\*\n");
    expect(s.hidden).toEqual(["~~", "~~", "==", "==", "`", "`", "\\", "\\"]);
    expect(s.marks).toContainEqual(["cm-ddl-inline-code", "`code`"]);
  });
});

describe("live preview: links", () => {
  it("renders inline links as their text", () => {
    const s = preview('see [the docs](https://example.com "t") ok');
    expect(s.hidden).toEqual(["[", '](https://example.com "t")']);
    expect(s.marks).toEqual([["cm-ddl-link", "the docs"]]);
  });

  it("reveals the whole link while it is being edited", () => {
    const s = preview("see [the docs](https://example.com) ok", { cursor: 8 });
    expect(s.hidden).toEqual([]);
    expect(s.marks).toEqual([]);
  });

  it("leaves bracketed text and reference links alone", () => {
    expect(preview("[not a link] and [ref][1]").hidden).toEqual([]);
  });

  it("keeps link destinations after a line break visible", () => {
    const s = preview("[text](\nhttps://example.com) end");
    for (const text of s.hidden) expect(text).not.toContain("\n");
  });

  it("styles autolinks and bare URLs as clickable links", () => {
    const s = preview("<https://a.example> and https://b.example end");
    expect(s.hidden).toEqual(["<", ">"]);
    expect(s.marks).toEqual([
      ["cm-ddl-link", "https://a.example"],
      ["cm-ddl-link", "https://b.example"],
    ]);
  });

  it("shows wikilink aliases, or the target when there is none", () => {
    const s = preview("[[Note|Alias]] then [[Other#Head]] end");
    expect(s.hidden).toEqual(["[[Note|", "]]", "[[", "]]"]);
    expect(s.marks).toEqual([
      ["cm-ddl-wikilink", "Alias"],
      ["cm-ddl-wikilink", "Other#Head"],
    ]);
  });

  it("reveals a wikilink when the caret touches it", () => {
    expect(preview("[[Note|Alias]] end", { cursor: 14 }).hidden).toEqual([]);
  });
});

describe("live preview: lists and tasks", () => {
  const tasks = "- [ ] open task\n- [x] done task\n";

  it("renders checkboxes and styles completed tasks", () => {
    const s = preview(tasks);
    expect(s.widgets).toEqual([
      ["- [ ]", "CheckboxWidget"],
      ["- [x]", "CheckboxWidget"],
    ]);
    expect(s.lines).toEqual([
      [1, "cm-ddl-task"],
      [2, "cm-ddl-task cm-ddl-task-done"],
    ]);
    expect(s.marks).toEqual([["cm-ddl-task-done-text", "done task"]]);
  });

  it("keeps the checkbox while typing the task text and reveals it on the marker", () => {
    expect(preview(tasks, { cursor: 6 }).widgets).toHaveLength(2);
    expect(preview(tasks, { cursor: 3 }).widgets).toEqual([["- [x]", "CheckboxWidget"]]);
  });

  it("renders an empty task created by Enter", () => {
    expect(preview("- [ ] ").widgets).toEqual([["- [ ]", "CheckboxWidget"]]);
  });

  it("replaces only the box in ordered lists, and handles alternate statuses", () => {
    const s = preview("1. [ ] step\n2. [-] dropped\n");
    expect(s.widgets.map(([text]) => text)).toEqual(["[ ]", "[-]"]);
    expect(s.lines).toContainEqual([2, "cm-ddl-task cm-ddl-task-cancelled"]);
    expect(s.marks).toEqual([["cm-ddl-task-cancelled-text", "dropped"]]);
  });

  it("flags checkboxes as read-only in read-only editors", () => {
    const s = preview("- [ ] task\n", { config: { readOnly: true } });
    const widget = s.decorations
      .map((d) => (d.deco.spec as { widget?: unknown }).widget)
      .find((w) => w !== undefined);
    expect(widget).toBeInstanceOf(CheckboxWidget);
    expect((widget as CheckboxWidget).readOnly).toBe(true);
  });

  it("renders bullets as dots unless the caret touches the marker", () => {
    const doc = "- item\n* other\n+ third";
    expect(preview(doc).widgets.map(([, w]) => w)).toEqual([
      "BulletWidget",
      "BulletWidget",
      "BulletWidget",
    ]);
    expect(preview(doc, { cursor: 1 }).widgets).toHaveLength(2);
  });
});

describe("live preview: blocks", () => {
  it("hides quote marks off the active line", () => {
    const doc = "> quoted\n> > nested\n\nnext";
    const s = preview(doc);
    expect(s.hidden).toEqual(["> ", "> ", "> "]);
    expect(s.lines).toEqual([
      [1, "cm-ddl-quote"],
      [2, "cm-ddl-quote"],
    ]);
    expect(preview(doc, { cursor: 3 }).hidden).toEqual(["> ", "> "]);
  });

  it("renders horizontal rules as a widget off the active line", () => {
    expect(preview("a\n\n---\n\nb").widgets).toEqual([["---", "HorizontalRuleWidget"]]);
    expect(preview("a\n\n---\n\nb", { cursor: 4 }).widgets).toEqual([]);
  });

  it("styles fenced code lines and keeps the fences visible", () => {
    const s = preview("```js\nlet a = 1;\n```\nafter");
    expect(s.hidden).toEqual([]);
    expect(s.lines).toEqual([
      [1, "cm-ddl-codeblock cm-ddl-codeblock-begin"],
      [2, "cm-ddl-codeblock"],
      [3, "cm-ddl-codeblock cm-ddl-codeblock-end"],
    ]);
    expect(s.marks).toEqual([
      ["cm-ddl-fence", "```js"],
      ["cm-ddl-fence", "```"],
    ]);
  });

  it("styles frontmatter instead of rendering it as a rule and a heading", () => {
    const doc = "---\ntitle: x\n---\n# Heading";
    const s = preview(doc);
    expect(frontmatterEnd(parsedState(doc).doc)).toBe(16);
    expect(s.widgets).toEqual([]);
    expect(s.lines).toEqual([
      [1, "cm-ddl-frontmatter"],
      [2, "cm-ddl-frontmatter"],
      [3, "cm-ddl-frontmatter"],
      [4, "cm-ddl-heading cm-ddl-h1"],
    ]);
  });
});

describe("live preview: viewport", () => {
  it("only decorates the visible ranges", () => {
    const doc = Array.from({ length: 40 }, (_, i) => `# Heading ${i}`).join("\n");
    const state = parsedState(doc);
    const from = state.doc.line(10).from;
    const to = state.doc.line(12).to;
    const s = preview(doc, { ranges: [{ from, to }] });
    expect(s.lines.map(([line]) => line)).toEqual([10, 11, 12]);
    for (const { from: f, to: t } of s.decorations) {
      expect(f).toBeGreaterThanOrEqual(from);
      expect(t).toBeLessThanOrEqual(to);
    }
  });

  it("decorates inline syntax that ends where a fold ends only once", () => {
    // Folding the first item leaves visible ranges [start, end of line 1] and [end of line 2, …];
    // the link and the emphasis continue onto line 2 and end exactly at the fold end.
    for (const doc of [
      "- [text\nmore](https://example.com)\n- next",
      "- *emphasis\nacross*\n- next",
    ]) {
      const state = parsedState(doc);
      const ranges = [
        { from: 0, to: state.doc.line(1).to },
        { from: state.doc.line(2).to, to: doc.length },
      ];
      const s = preview(doc, { ranges, cursor: doc.length });
      const replaced = s.decorations
        .filter((d) => !(d.deco.spec as { class?: string }).class)
        .map((d) => `${d.from}-${d.to}`);
      expect(replaced.length, doc).toBeGreaterThan(0);
      expect(new Set(replaced).size, doc).toBe(replaced.length);
    }
  });

  it("never hides a line break", () => {
    const doc = [
      "# H #",
      "- [ ] a [[b|c]] **d** [e](\nf)",
      "> q",
      "1. [x] g `h` ==i==",
      "***",
      "<https://j.example>",
    ].join("\n");
    for (const text of preview(doc).hidden) expect(text).not.toContain("\n");
  });
});

describe("live preview: embeds", () => {
  const drawings: EmbedRenderer = {
    kind: "drawing",
    matches: (target) => target.endsWith(".excalidraw"),
    mount: () => ({ destroy() {} }),
  };
  const callbacks = { embedRenderers: [drawings] };
  const doc = "Intro\n![[Plan.excalidraw|360|right-wrap]]\nText next to it";

  function widgetOf(s: Summary): EmbedWidget | null {
    const found = s.decorations.find((d) => d.deco.spec.widget instanceof EmbedWidget);
    return (found?.deco.spec.widget as EmbedWidget | undefined) ?? null;
  }

  it("draws an embed a renderer matches as a box, and marks its line with the placement", () => {
    const s = preview(doc, { callbacks, cursor: 0 });
    expect(s.widgets).toEqual([["![[Plan.excalidraw|360|right-wrap]]", "EmbedWidget"]]);
    expect(s.lines).toContainEqual([2, "cm-ddl-embed-line cm-ddl-embed-line-right-wrap"]);
    const widget = widgetOf(s)!;
    expect(widget.renderer).toBe(drawings);
    expect(widget.embed.spec).toMatchObject({ width: 360, placement: "right-wrap" });
    expect(widget.selected).toBe(false);
  });

  it("shows the whole syntax while the caret is on its line, and draws it without focus", () => {
    const onLine = preview(doc, { callbacks, cursor: 10 });
    expect(onLine.widgets).toEqual([]);
    expect(onLine.hidden).toEqual([]);
    expect(preview(doc, { callbacks, cursor: 10, focused: false }).widgets).toHaveLength(1);
  });

  it("leaves embeds no renderer matches, and embeds among text, to the wikilink rules", () => {
    expect(preview("![[photo.png|300]]\nx", { callbacks, cursor: 20 }).widgets).toEqual([]);
    const inline = preview("See ![[Plan.excalidraw]] here\nx", { callbacks, cursor: 30 });
    expect(inline.widgets).toEqual([]);
    expect(inline.marks).toContainEqual(["cm-ddl-wikilink", "Plan.excalidraw"]);
    expect(preview(doc, { cursor: 0 }).widgets).toEqual([]);
  });

  it("never draws an embed in code", () => {
    const code = "```\n![[Plan.excalidraw]]\n```\nx";
    expect(preview(code, { callbacks, cursor: code.length }).widgets).toEqual([]);
  });

  it("marks the selected embed, which moving the caret deselects", () => {
    const state = parsedState(doc, { callbacks, selection: { anchor: 0 } });
    const selected = state.update({ effects: selectEmbedEffect.of(6) }).state;
    const ranges = [{ from: 0, to: doc.length }];
    const find = (set: ReturnType<typeof buildLivePreviewDecorations>) => {
      let widget: EmbedWidget | null = null;
      set.between(0, doc.length, (_from, _to, deco) => {
        if (deco.spec.widget instanceof EmbedWidget) widget = deco.spec.widget;
      });
      return widget as EmbedWidget | null;
    };
    expect(find(buildLivePreviewDecorations(selected, ranges, true))?.selected).toBe(true);
    const moved = selected.update({ selection: { anchor: doc.length } }).state;
    expect(find(buildLivePreviewDecorations(moved, ranges, true))?.selected).toBe(false);
  });
});
