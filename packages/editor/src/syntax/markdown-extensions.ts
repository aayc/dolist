/**
 * Obsidian syntax on top of GFM, as @lezer/markdown extensions: wikilinks/embeds, `==highlight==`
 * and `#tags`. Being part of the parse means they are never detected inside code spans or blocks,
 * and the live preview can treat them like any other syntax node.
 */
import { Tag, tags } from "@lezer/highlight";
import type {
  BlockContext,
  InlineContext,
  LeafBlock,
  LeafBlockParser,
  MarkdownConfig,
} from "@lezer/markdown";

/** Highlight tags for the node types added here (styled by the editor's HighlightStyle). */
export const ddlTags = {
  wikiLink: Tag.define(tags.link),
  highlight: Tag.define(),
  hashtag: Tag.define(),
};

const CH_TAB = 9;
const CH_NEWLINE = 10;
const CH_CR = 13;
const CH_SPACE = 32;
const CH_BANG = 33;
const CH_HASH = 35;
const CH_DASH = 45;
const CH_SLASH = 47;
const CH_EQUALS = 61;
const CH_LBRACKET = 91;
const CH_RBRACKET = 93;
const CH_UNDERSCORE = 95;
const CH_PIPE = 124;

/**
 * `[[target]]`, `[[target#heading|alias]]` and `![[embed]]`. Produces
 * `WikiLink > WikiLinkMark, WikiLinkTarget, (WikiLinkMark, WikiLinkAlias?)?, WikiLinkMark`.
 */
export const WikiLinkSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink" },
    { name: "WikiLinkMark", style: tags.processingInstruction },
    { name: "WikiLinkTarget", style: ddlTags.wikiLink },
    { name: "WikiLinkAlias", style: ddlTags.wikiLink },
  ],
  // Must run before the standard link/image parsers, which would claim the inner `[...]`.
  parseInline: [{ name: "WikiLink", before: "Link", parse: parseWikiLink }],
};

function parseWikiLink(cx: InlineContext, next: number, pos: number): number {
  let open = pos;
  if (next === CH_BANG) open = pos + 1;
  else if (next !== CH_LBRACKET) return -1;
  if (cx.char(open) !== CH_LBRACKET || cx.char(open + 1) !== CH_LBRACKET) return -1;

  const contentFrom = open + 2;
  let pipe = -1;
  let close = contentFrom;
  for (; close < cx.end; close++) {
    const ch = cx.char(close);
    if (ch === CH_NEWLINE || ch === CH_LBRACKET) return -1;
    if (ch === CH_RBRACKET) break;
    if (ch === CH_PIPE && pipe < 0) pipe = close;
  }
  if (cx.char(close) !== CH_RBRACKET || cx.char(close + 1) !== CH_RBRACKET) return -1;
  const targetTo = pipe < 0 ? close : pipe;
  if (targetTo === contentFrom) return -1;

  const children = [
    cx.elt("WikiLinkMark", pos, contentFrom),
    cx.elt("WikiLinkTarget", contentFrom, targetTo),
  ];
  if (pipe >= 0) {
    children.push(cx.elt("WikiLinkMark", pipe, pipe + 1));
    if (close > pipe + 1) children.push(cx.elt("WikiLinkAlias", pipe + 1, close));
  }
  children.push(cx.elt("WikiLinkMark", close, close + 2));
  return cx.addElement(cx.elt("WikiLink", pos, close + 2, children));
}

const PUNCTUATION = /[\p{S}\p{P}]/u;
const HighlightDelimiter = { resolve: "Highlight", mark: "HighlightMark" };

/** `==highlight==`, with the same flanking rules GFM uses for `~~strikethrough~~`. */
export const HighlightSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": ddlTags.highlight } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      after: "Emphasis",
      parse(cx, next, pos) {
        if (
          next !== CH_EQUALS ||
          cx.char(pos + 1) !== CH_EQUALS ||
          cx.char(pos + 2) === CH_EQUALS
        ) {
          return -1;
        }
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctBefore = PUNCTUATION.test(before);
        const punctAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          HighlightDelimiter,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        );
      },
    },
  ],
};

const TAG_UNICODE = /[\p{L}\p{N}\p{M}]/u;

function isTagChar(code: number): boolean {
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
    return true;
  }
  if (code === CH_UNDERSCORE || code === CH_DASH || code === CH_SLASH) return true;
  return code > 127 && TAG_UNICODE.test(String.fromCharCode(code));
}

function isWhitespace(code: number): boolean {
  return code === CH_SPACE || code === CH_TAB || code === CH_NEWLINE || code === CH_CR;
}

/**
 * Obsidian tags: `#` at the start of inline content or after whitespace, followed by letters,
 * digits, `_`, `-` or `/`, with at least one non-digit (`#123` is not a tag).
 */
export const HashtagSyntax: MarkdownConfig = {
  defineNodes: [{ name: "Hashtag", style: ddlTags.hashtag }],
  parseInline: [
    {
      name: "Hashtag",
      parse(cx, next, pos) {
        if (next !== CH_HASH) return -1;
        if (pos > cx.offset && !isWhitespace(cx.char(pos - 1))) return -1;
        let end = pos + 1;
        let hasNonDigit = false;
        while (end < cx.end) {
          const code = cx.char(end);
          if (!isTagChar(code)) break;
          if (code < 48 || code > 57) hasNonDigit = true;
          end++;
        }
        if (!hasNonDigit) return -1;
        return cx.addElement(cx.elt("Hashtag", pos, end));
      },
    },
  ],
};

/**
 * Indented code blocks are disabled: in a to-do list an accidentally indented task must stay a task
 * (this also matches `parseTasks` in `@ddl/core`, which has no notion of indented code).
 */
export const DisableIndentedCode: MarkdownConfig = { remove: ["IndentedCode"] };

class AlternateTaskParser implements LeafBlockParser {
  nextLine(): boolean {
    return false;
  }

  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(
      leaf,
      cx.elt("Task", leaf.start, leaf.start + leaf.content.length, [
        cx.elt("TaskMarker", leaf.start, leaf.start + 3),
        ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
      ]),
    );
    return true;
  }
}

/**
 * GFM only knows `[ ]` and `[x]`. Obsidian's alternate statuses (`[/]` in progress, `[-]`
 * cancelled, `[>]` deferred, …) are tasks for `@ddl/core` too, so they parse as the same
 * `Task`/`TaskMarker` nodes.
 */
export const AlternateTaskSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "Task", block: true, style: tags.list },
    { name: "TaskMarker", style: tags.atom },
  ],
  parseBlock: [
    {
      name: "AlternateTask",
      before: "TaskList",
      leaf: (cx, leaf) =>
        /^\[[^ xX\]\n]\][ \t]/.test(leaf.content) && cx.parentType().name === "ListItem"
          ? new AlternateTaskParser()
          : null,
    },
  ],
};

export interface WikiLinkParts {
  /** Note target without the `#subpath`, e.g. `Daily/2026-06-19`. Empty for `[[#Heading]]`. */
  target: string;
  /** `Heading` or `^block` (without the `#`), if present. */
  subpath?: string;
  alias?: string;
}

/** Splits the inner text of a wikilink (`target#subpath|alias`) into its parts. */
export function splitWikiLink(inner: string): WikiLinkParts {
  const pipe = inner.indexOf("|");
  const targetText = pipe < 0 ? inner : inner.slice(0, pipe);
  const hash = targetText.indexOf("#");
  const parts: WikiLinkParts = {
    target: (hash < 0 ? targetText : targetText.slice(0, hash)).trim(),
  };
  const subpath = hash < 0 ? "" : targetText.slice(hash + 1).trim();
  if (subpath) parts.subpath = subpath;
  const alias = pipe < 0 ? "" : inner.slice(pipe + 1).trim();
  if (alias) parts.alias = alias;
  return parts;
}
