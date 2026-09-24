/**
 * Obsidian-style live preview decorations, computed for the visible ranges only from the syntax
 * tree. Pure (state in, decorations out) so it can be tested and benchmarked without a view.
 *
 * Reveal rules (syntax shows while the selection touches it; nothing is revealed without focus):
 * - inline syntax (emphasis, code, links, wikilinks, escapes): when the selection touches the node;
 * - block syntax (heading `#`, quote `>`, horizontal rules): when the selection is on the line;
 * - bullets and task checkboxes: when the selection touches the marker itself, so the checkbox stays
 *   rendered while typing the task text.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Line, Range, SelectionRange, Text } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { RENDERED_LINK_CLASS, RENDERED_WIKILINK_CLASS } from "../links";
import { isDoneStatusChar } from "../task-lines";
import { BulletWidget, CheckboxWidget, HorizontalRuleWidget } from "./widgets";

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];
type SyntaxNodeRef = Parameters<Parameters<Tree["iterate"]>[0]["enter"]>[0];

export interface VisibleRange {
  from: number;
  to: number;
}

const HIDE = Decoration.replace({});
const BULLET = Decoration.replace({ widget: new BulletWidget() });
const HORIZONTAL_RULE = Decoration.replace({ widget: new HorizontalRuleWidget() });
const LINK = Decoration.mark({ class: RENDERED_LINK_CLASS });
const WIKILINK = Decoration.mark({ class: RENDERED_WIKILINK_CLASS });
const INLINE_CODE = Decoration.mark({ class: "cm-ddl-inline-code" });
const FENCE = Decoration.mark({ class: "cm-ddl-fence" });
const TASK_DONE_TEXT = Decoration.mark({ class: "cm-ddl-task-done-text" });
const TASK_CANCELLED_TEXT = Decoration.mark({ class: "cm-ddl-task-cancelled-text" });
const TASK_LINE = Decoration.line({ class: "cm-ddl-task" });
const TASK_DONE_LINE = Decoration.line({ class: "cm-ddl-task cm-ddl-task-done" });
const TASK_CANCELLED_LINE = Decoration.line({ class: "cm-ddl-task cm-ddl-task-cancelled" });
const QUOTE_LINE = Decoration.line({ class: "cm-ddl-quote" });
const FRONTMATTER_LINE = Decoration.line({ class: "cm-ddl-frontmatter" });
const CODE_LINE = Decoration.line({ class: "cm-ddl-codeblock" });
const CODE_BEGIN = Decoration.line({ class: "cm-ddl-codeblock cm-ddl-codeblock-begin" });
const CODE_END = Decoration.line({ class: "cm-ddl-codeblock cm-ddl-codeblock-end" });
const CODE_SINGLE = Decoration.line({
  class: "cm-ddl-codeblock cm-ddl-codeblock-begin cm-ddl-codeblock-end",
});
const HEADING_LINES = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-ddl-heading cm-ddl-h${level}` }),
);

const HEADING_LEVEL: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

const INLINE_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "HighlightMark"]);
const CODE_MARKS = new Set(["CodeMark"]);
const LINK_CONTAINERS = new Set(["Link", "Image", "Autolink"]);
/** Nodes rendered as source: nothing inside them is decorated. */
const OPAQUE = new Set(["Table", "Image", "HTMLBlock", "CommentBlock", "LinkReference"]);
const CLOSING_FENCE = /^\s*(?:`{3,}|~{3,})\s*$/;
const FRONTMATTER_OPEN = /^---\s*$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)\s*$/;
const FRONTMATTER_MAX_LINES = 200;

const checkboxCache = new Map<string, Decoration>();

function checkbox(statusChar: string, readOnly: boolean): Decoration {
  const key = `${statusChar}\u0000${readOnly}`;
  let deco = checkboxCache.get(key);
  if (!deco) {
    deco = Decoration.replace({ widget: new CheckboxWidget(statusChar, readOnly) });
    checkboxCache.set(key, deco);
  }
  return deco;
}

/** End offset of a YAML frontmatter block (`---` on line 1 up to a closing `---`/`...`), or 0. */
export function frontmatterEnd(doc: Text): number {
  if (doc.lines < 2 || !FRONTMATTER_OPEN.test(doc.line(1).text)) return 0;
  const last = Math.min(doc.lines, FRONTMATTER_MAX_LINES);
  for (let n = 2; n <= last; n++) {
    const line = doc.line(n);
    if (FRONTMATTER_CLOSE.test(line.text)) return line.to;
  }
  return 0;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9;
}

class LivePreviewBuilder {
  private readonly ranges: Range<Decoration>[] = [];
  private readonly doc: Text;
  private readonly selection: readonly SelectionRange[];
  private readonly readOnly: boolean;
  private readonly frontmatterEnd: number;
  private rangeFrom = 0;
  private rangeTo = 0;
  private firstVisibleLine = 1;
  private lastVisibleLine = 1;
  private quoteLine = -1;
  private quoteLineRevealed = false;

  constructor(state: EditorState, focused: boolean) {
    this.doc = state.doc;
    this.selection = focused ? state.selection.ranges : [];
    this.readOnly = state.readOnly;
    this.frontmatterEnd = frontmatterEnd(state.doc);
  }

  run(tree: Tree, from: number, to: number): void {
    this.rangeFrom = from;
    this.rangeTo = to;
    this.firstVisibleLine = this.doc.lineAt(from).number;
    this.lastVisibleLine = this.doc.lineAt(to).number;
    if (this.frontmatterEnd > 0 && from <= this.frontmatterEnd) {
      this.lineRange(
        this.doc.line(1),
        this.doc.lineAt(this.frontmatterEnd),
        () => FRONTMATTER_LINE,
      );
    }
    tree.iterate({ from, to, enter: (node) => this.enter(node) });
  }

  finish(): DecorationSet {
    return Decoration.set(this.ranges, true);
  }

  private touches(from: number, to: number): boolean {
    for (const range of this.selection) if (range.from <= to && range.to >= from) return true;
    return false;
  }

  private hide(from: number, to: number): void {
    if (to > from) this.ranges.push(HIDE.range(from, to));
  }

  /** Line decorations for the visible part of a line span. */
  private lineRange(first: Line, last: Line, deco: (n: number) => Decoration): void {
    const start = Math.max(first.number, this.firstVisibleLine);
    const end = Math.min(last.number, this.lastVisibleLine);
    for (let n = start; n <= end; n++) this.ranges.push(deco(n).range(this.doc.line(n).from));
  }

  private enter(node: SyntaxNodeRef): boolean {
    const { name } = node;
    if (node.from < this.frontmatterEnd && name !== "Document") return false;
    if (OPAQUE.has(name)) return false;
    const level = HEADING_LEVEL[name];
    if (level !== undefined) {
      if (name.startsWith("ATX")) this.atxHeading(node.node, level);
      else this.setextHeading(node.node, level);
      return true;
    }
    switch (name) {
      case "Emphasis":
      case "StrongEmphasis":
      case "Strikethrough":
      case "Highlight":
        if (!this.touches(node.from, node.to)) this.hideChildren(node.node, INLINE_MARKS);
        return true;
      case "InlineCode":
        this.ranges.push(INLINE_CODE.range(node.from, node.to));
        if (!this.touches(node.from, node.to)) this.hideChildren(node.node, CODE_MARKS);
        return false;
      case "Link":
        this.link(node.node);
        return true;
      case "Autolink":
        this.autolink(node.node);
        return false;
      case "URL":
        this.bareUrl(node.node);
        return false;
      case "WikiLink":
        this.wikiLink(node.node);
        return false;
      case "QuoteMark":
        this.quoteMark(node.from, node.to);
        return false;
      case "HorizontalRule":
        this.horizontalRule(node.from, node.to);
        return false;
      case "FencedCode":
        this.fencedCode(node.from, node.to);
        return false;
      case "ListItem":
        this.listItem(node.node);
        return true;
      case "Escape":
        if (!this.touches(node.from, node.to)) this.hide(node.from, node.from + 1);
        return false;
      default:
        return true;
    }
  }

  private hideChildren(node: SyntaxNode, names: ReadonlySet<string>): void {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (names.has(child.name)) this.hide(child.from, child.to);
    }
  }

  private atxHeading(node: SyntaxNode, level: number): void {
    const line = this.doc.lineAt(node.from);
    this.ranges.push(HEADING_LINES[level - 1]!.range(line.from));
    if (this.touches(line.from, line.to)) return;
    let openingEnd = line.from;
    for (let mark = node.firstChild; mark; mark = mark.nextSibling) {
      if (mark.name !== "HeaderMark") continue;
      if (mark.from === node.from) {
        openingEnd =
          mark.to < line.to && isSpace(line.text.charCodeAt(mark.to - line.from))
            ? mark.to + 1
            : mark.to;
        this.hide(mark.from, openingEnd);
      } else {
        let start = mark.from;
        while (start > openingEnd && isSpace(line.text.charCodeAt(start - 1 - line.from))) start--;
        this.hide(start, mark.to);
      }
    }
  }

  private setextHeading(node: SyntaxNode, level: number): void {
    const underline = node.lastChild;
    const first = this.doc.lineAt(node.from);
    const last =
      underline?.name === "HeaderMark"
        ? this.doc.line(Math.max(first.number, this.doc.lineAt(underline.from).number - 1))
        : this.doc.lineAt(node.to);
    const deco = HEADING_LINES[level - 1]!;
    this.lineRange(first, last, () => deco);
  }

  private link(node: SyntaxNode): void {
    const open = node.firstChild;
    if (open?.name !== "LinkMark") return;
    let close: SyntaxNode | null = null;
    let hasUrl = false;
    for (let child = open.nextSibling; child; child = child.nextSibling) {
      if (child.name === "LinkMark" && !close) close = child;
      else if (child.name === "URL") hasUrl = true;
    }
    // Only inline links: `[text]` / `[text][ref]` stay as typed.
    if (!close || !hasUrl || close.from <= open.to || this.touches(node.from, node.to)) return;
    // The destination may follow a line break, which a plugin decoration must not hide.
    if (this.doc.lineAt(close.from).to < node.to) return;
    this.hide(node.from, open.to);
    this.hide(close.from, node.to);
    this.ranges.push(LINK.range(open.to, close.from));
  }

  private autolink(node: SyntaxNode): void {
    const url = node.getChild("URL");
    if (!url || this.touches(node.from, node.to)) return;
    this.hide(node.from, url.from);
    this.hide(url.to, node.to);
    this.ranges.push(LINK.range(url.from, url.to));
  }

  private bareUrl(node: SyntaxNode): void {
    const parent = node.parent;
    if (parent && LINK_CONTAINERS.has(parent.name)) return;
    if (!this.touches(node.from, node.to)) this.ranges.push(LINK.range(node.from, node.to));
  }

  private wikiLink(node: SyntaxNode): void {
    if (this.touches(node.from, node.to)) return;
    let target: SyntaxNode | null = null;
    let alias: SyntaxNode | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "WikiLinkTarget") target = child;
      else if (child.name === "WikiLinkAlias") alias = child;
    }
    const shown = alias ?? target;
    if (!shown) return;
    this.hide(node.from, shown.from);
    this.hide(shown.to, node.to);
    this.ranges.push(WIKILINK.range(shown.from, shown.to));
  }

  private quoteMark(from: number, to: number): void {
    const line = this.doc.lineAt(from);
    if (line.number !== this.quoteLine) {
      this.quoteLine = line.number;
      this.quoteLineRevealed = this.touches(line.from, line.to);
      this.ranges.push(QUOTE_LINE.range(line.from));
    }
    if (this.quoteLineRevealed) return;
    this.hide(from, to < line.to && isSpace(line.text.charCodeAt(to - line.from)) ? to + 1 : to);
  }

  private horizontalRule(from: number, to: number): void {
    const line = this.doc.lineAt(from);
    if (!this.touches(line.from, line.to)) this.ranges.push(HORIZONTAL_RULE.range(from, to));
  }

  private fencedCode(from: number, to: number): void {
    const first = this.doc.lineAt(from);
    const last = this.doc.lineAt(to);
    this.lineRange(first, last, (n) => {
      if (n === first.number) return n === last.number ? CODE_SINGLE : CODE_BEGIN;
      return n === last.number ? CODE_END : CODE_LINE;
    });
    if (first.number >= this.firstVisibleLine && first.to > first.from) {
      this.ranges.push(FENCE.range(first.from, first.to));
    }
    if (
      last.number > first.number &&
      last.number <= this.lastVisibleLine &&
      CLOSING_FENCE.test(last.text)
    ) {
      this.ranges.push(FENCE.range(last.from, last.to));
    }
  }

  private listItem(item: SyntaxNode): void {
    const mark = item.firstChild;
    // Items spanning several visible ranges (around a fold) are decorated once, where they start.
    if (mark?.name !== "ListMark" || mark.from < this.rangeFrom || mark.from > this.rangeTo) {
      return;
    }
    const bullet = item.parent?.name === "BulletList";
    const task = mark.nextSibling;
    const marker = task?.name === "Task" ? task.firstChild : null;
    if (!task || marker?.name !== "TaskMarker") {
      if (bullet && !this.touches(mark.from, mark.to)) {
        this.ranges.push(BULLET.range(mark.from, mark.to));
      }
      return;
    }
    const statusChar = this.doc.sliceString(marker.from + 1, marker.to - 1);
    const from = bullet ? mark.from : marker.from;
    if (!this.touches(from, marker.to)) {
      this.ranges.push(checkbox(statusChar, this.readOnly).range(from, marker.to));
    }
    const done = isDoneStatusChar(statusChar);
    const cancelled = statusChar === "-";
    const line = this.doc.lineAt(task.from);
    this.ranges.push(
      (done ? TASK_DONE_LINE : cancelled ? TASK_CANCELLED_LINE : TASK_LINE).range(line.from),
    );
    if (done || cancelled) {
      const next = marker.to < line.to ? line.text.charCodeAt(marker.to - line.from) : 0;
      const textFrom = isSpace(next) ? marker.to + 1 : marker.to;
      if (task.to > textFrom) {
        this.ranges.push((done ? TASK_DONE_TEXT : TASK_CANCELLED_TEXT).range(textFrom, task.to));
      }
    }
  }
}

/**
 * Live preview decorations for `visibleRanges`. `focused` controls syntax reveal: an unfocused
 * editor has no visible caret, so everything renders.
 */
export function buildLivePreviewDecorations(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
  focused: boolean,
): DecorationSet {
  const builder = new LivePreviewBuilder(state, focused);
  const tree = syntaxTree(state);
  for (const { from, to } of visibleRanges) builder.run(tree, from, to);
  return builder.finish();
}
