/**
 * fast-check arbitraries for property tests (not part of the public API): random Obsidian-flavoured
 * markdown, selections and viewports.
 *
 * Fence info strings never name a real language: `@codemirror/language-data` would start loading a
 * parser chunk in the middle of a test run. For the same reason a line never starts with a stray
 * backtick or tilde (two stray tokens could form a fence whose info string is random text).
 */
import { EditorSelection, type SelectionRange, Text } from "@codemirror/state";
import { fc } from "@fast-check/vitest";
import type { VisibleRange } from "./live-preview/decorations";

const WORDS = [
  "alpha",
  "Beta",
  "gamma",
  "task",
  "δέλτα",
  "日本語",
  "😀",
  "👩‍💻",
  "e\u0301",
  "مرحبا",
  "x",
  "42",
  "\u00a0",
  "a_b",
  "snake_case",
] as const;

const word = fc.constantFrom(...WORDS);

/** One to three words: never empty, never starts with markdown syntax. */
export const plainText = fc
  .array(word, { minLength: 1, maxLength: 3 })
  .map((words) => words.join(" "));

const URLS = [
  "https://example.com",
  "https://example.com/a_b?q=1#frag",
  "mailto:someone@example.com",
];

const inlineToken: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: plainText },
  {
    weight: 4,
    arbitrary: fc
      .tuple(fc.constantFrom("*", "**", "***", "_", "__", "~~", "=="), plainText)
      .map(([mark, text]) => `${mark}${text}${mark}`),
  },
  { weight: 2, arbitrary: plainText.map((text) => `\`${text}\``) },
  { weight: 1, arbitrary: plainText.map((text) => `\`\` ${text} \`\``) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(plainText, fc.constantFrom(...URLS), fc.boolean())
      .map(([text, url, title]) => `[${text}](${url}${title ? ' "title"' : ""})`),
  },
  { weight: 1, arbitrary: plainText.map((text) => `[${text}][ref]`) },
  { weight: 1, arbitrary: plainText.map((text) => `[${text}]`) },
  { weight: 1, arbitrary: plainText.map((text) => `![${text}](image.png)`) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      "<https://example.com>",
      "https://example.com/path",
      "www.example.com",
      "someone@example.com",
    ),
  },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        fc.constantFrom("", "!"),
        plainText,
        fc.constantFrom("", "#Heading", "#^block"),
        fc.option(plainText, { nil: undefined }),
      )
      .map(([bang, target, sub, alias]) => `${bang}[[${target}${sub}${alias ? `|${alias}` : ""}]]`),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom("[[", "]]", "[[|x]]", "[[a|]]", "[[#Local]]", "[[a [b]]"),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom("#tag", "#nested/tag-1", "#日本語", "#123", "a#b", "(#paren)"),
  },
  { weight: 1, arbitrary: fc.constantFrom("\\*", "\\[", "\\\\", "\\#", "\\`") },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      "<span>html</span>",
      "<b>",
      "</b>",
      "<!-- note -->",
      "<br>",
      "&amp;",
      "&#x1F600;",
    ),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "*",
      "**",
      "_",
      "~",
      "=",
      "==",
      "`",
      "``",
      "[",
      "]",
      "(",
      ")",
      "<",
      ">",
      "|",
      "!",
      "#",
      "\t",
    ),
  },
);

/** Inline content of one line; the first token is always plain text (see the module comment). */
export const inlineContent: fc.Arbitrary<string> = fc
  .tuple(plainText, fc.array(fc.tuple(fc.constantFrom("", " "), inlineToken), { maxLength: 5 }))
  .map(([first, rest]) => first + rest.map(([sep, token]) => sep + token).join(""));

export const TASK_STATUSES = [" ", "x", "X", "/", "-", ">", "?", "!"] as const;
export const taskStatus = fc.constantFrom(...TASK_STATUSES);

const indent = fc.constantFrom("", "", "", "\t", "\t\t", "  ", "    ", " \t");
const bullet = fc.constantFrom("-", "*", "+");
const ordered = fc.constantFrom("1.", "2)", "10.", "9)");

const blockPrefix: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: fc.constant("") },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 7 }).map((n) => `${"#".repeat(n)} `) },
  { weight: 2, arbitrary: fc.constantFrom("> ", "> > ", ">", ">> ", "> - ", "> - [ ] ") },
  {
    weight: 3,
    arbitrary: fc.tuple(indent, bullet).map(([pad, mark]) => `${pad}${mark} `),
  },
  {
    weight: 2,
    arbitrary: fc.tuple(indent, ordered).map(([pad, mark]) => `${pad}${mark} `),
  },
  {
    weight: 5,
    arbitrary: fc
      .tuple(indent, fc.oneof(bullet, ordered), taskStatus, fc.constantFrom(" ", "  ", "\t"))
      .map(([pad, mark, status, space]) => `${pad}${mark} [${status}]${space}`),
  },
);

const specialLine = fc.constantFrom(
  "",
  "",
  "   ",
  "\t",
  "---",
  "***",
  "___",
  "- - -",
  "===",
  "```",
  "```zzz",
  "~~~",
  "````",
  "| a | b |",
  "| - | - |",
  "|1|2|",
  "<div>",
  "</div>",
  "<!-- comment",
  "-->",
  "[ref]: https://example.com",
  "    four spaces",
  "- [ ]",
  "- [ ] ",
  "-",
  "1.",
  "> ",
  "#",
  "# #",
  "#  ##",
  "### closed ###",
  // Constructs spanning a line break.
  "[link](\nhttps://example.com) after",
  "[text\nmore](https://example.com)",
  "*emphasis\nacross* lines",
  "`code\nspan`",
  "==high\nlight==",
  "<https://\nexample.com>",
  "> quote\ncontinued lazily",
  "- [x] done\ncontinued lazily",
  "- [-] cancelled\n  indented continuation",
  "Setext\n===",
  "Setext two\n---",
  "> ```\n> code in a quote\n> ```",
  "> | a | b |\n> | - | - |",
);

export const markdownLine: fc.Arbitrary<string> = fc.oneof(
  { weight: 7, arbitrary: fc.tuple(blockPrefix, inlineContent).map(([p, c]) => p + c) },
  { weight: 3, arbitrary: specialLine },
  // A heading with a closing sequence, or text followed by trailing spaces.
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.integer({ min: 1, max: 6 }), inlineContent, fc.constantFrom(" #", " ###", "  "))
      .map(([n, c, tail]) => `${"#".repeat(n)} ${c}${tail}`),
  },
);

const frontmatter = fc
  .tuple(
    fc.array(fc.constantFrom("title: Note", "tags: [a, b]", "# not a heading", "- item", ""), {
      maxLength: 3,
    }),
    fc.constantFrom("---", "..."),
  )
  .map(([body, close]) => ["---", ...body, close].join("\n"));

/** A markdown document of 0–`maxLines` lines, sometimes with YAML frontmatter. */
export function markdownDoc(maxLines = 30): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.oneof(
        { weight: 5, arbitrary: fc.constant(undefined) },
        { weight: 1, arbitrary: frontmatter },
      ),
      fc.array(markdownLine, { maxLength: maxLines }),
      fc.boolean(),
    )
    .map(([front, lines, trailingNewline]) => {
      const body = lines.join("\n");
      const doc = front === undefined ? body : body ? `${front}\n${body}` : front;
      return trailingNewline ? `${doc}\n` : doc;
    });
}

/** A document together with a position in it. */
export function docWithPos(doc: fc.Arbitrary<string>): fc.Arbitrary<[string, number]> {
  return doc.chain((text) => fc.tuple(fc.constant(text), fc.integer({ min: 0, max: text.length })));
}

/** Plain-data selection (prints readably in counterexamples); see `toSelection`. */
export interface SelectionSpec {
  ranges: Array<[anchor: number, head: number]>;
  main: number;
}

/** 1–3 selection ranges (carets or ranges, possibly overlapping) within `[0, length]`. */
export function selectionIn(length: number, maxRanges = 3): fc.Arbitrary<SelectionSpec> {
  const pos = fc.integer({ min: 0, max: length });
  const range: fc.Arbitrary<[number, number]> = fc.oneof(
    pos.map((p): [number, number] => [p, p]),
    fc.tuple(pos, pos),
  );
  return fc
    .array(range, { minLength: 1, maxLength: maxRanges })
    .chain((ranges) =>
      fc.integer({ min: 0, max: ranges.length - 1 }).map((main) => ({ ranges, main })),
    );
}

export function toSelection(spec: SelectionSpec): EditorSelection {
  const ranges: SelectionRange[] = spec.ranges.map(([anchor, head]) =>
    EditorSelection.range(anchor, head),
  );
  return EditorSelection.create(ranges, spec.main);
}

/** CodeMirror's line structure for a string, without building a state. */
export function textOf(doc: string): Text {
  return Text.of(doc.split("\n"));
}

/** UTF-16 offsets that don't fall inside a surrogate pair (where a real caret can be). */
export function codePointBoundaries(text: string): number[] {
  const out = [0];
  for (const ch of text) out.push(out[out.length - 1]! + ch.length);
  return out;
}

/**
 * Viewports shaped like CodeMirror's `visibleRanges`: the whole document, one line-aligned range,
 * or two ranges around a fold (the second starts at the end of the last folded line).
 */
export function visibleRangesIn(doc: Text): fc.Arbitrary<VisibleRange[]> {
  const line = fc.integer({ min: 1, max: doc.lines });
  const whole = fc.constant<VisibleRange[]>([{ from: 0, to: doc.length }]);
  const window = fc.tuple(line, line).map(([a, b]) => {
    const [first, last] = a <= b ? [a, b] : [b, a];
    return [{ from: doc.line(first).from, to: doc.line(last).to }];
  });
  if (doc.lines < 4) return fc.oneof(whole, window);
  const folded = fc
    .uniqueArray(fc.integer({ min: 1, max: doc.lines }), { minLength: 4, maxLength: 4 })
    .map((picked) => {
      const [first, foldStart, foldEnd, last] = picked.sort((x, y) => x - y) as [
        number,
        number,
        number,
        number,
      ];
      return [
        { from: doc.line(first).from, to: doc.line(foldStart).to },
        { from: doc.line(foldEnd).to, to: doc.line(last).to },
      ];
    });
  return fc.oneof(whole, window, folded);
}

/** Sorted, disjoint ranges with arbitrary (not line-aligned) boundaries. */
export function arbitraryRangesIn(length: number): fc.Arbitrary<VisibleRange[]> {
  return fc
    .uniqueArray(fc.integer({ min: 0, max: length }), { minLength: 1, maxLength: 6 })
    .map((points) => {
      const sorted = points.sort((a, b) => a - b);
      if (sorted.length === 1) return [{ from: sorted[0]!, to: sorted[0]! }];
      const ranges: VisibleRange[] = [];
      for (let i = 0; i + 1 < sorted.length; i += 2)
        ranges.push({ from: sorted[i]!, to: sorted[i + 1]! });
      return ranges;
    });
}
