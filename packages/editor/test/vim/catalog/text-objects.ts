/** Text objects × operators × positions (inside, on a delimiter, nested, multiline, not found). */
import { type Catalog, label } from "./builder";
import { BRACKETS, CODE, type Doc, PROSE, PUNCT, SINGLE, UNICODE, WORDS } from "./docs";

type Start = readonly [Doc, string];

const WORD_STARTS: readonly Start[] = [
  [WORDS, "bof"],
  [WORDS, "mid-word"],
  [WORDS, "space"],
  [WORDS, "eol"],
  [PUNCT, "dot"],
  [PUNCT, "arrow"],
  [PUNCT, "indent"],
  [UNICODE, "accent"],
  [UNICODE, "cjk"],
  [SINGLE, "eol"],
];

const SENTENCE_STARTS: readonly Start[] = [
  [PROSE, "bof"],
  [PROSE, "mid-sentence"],
  [PROSE, "sentence-end"],
  [PROSE, "after-bang"],
  [PROSE, "double-space"],
  [PROSE, "empty-line"],
  [SINGLE, "mid"],
];

const PARAGRAPH_STARTS: readonly Start[] = [
  [PROSE, "bof"],
  [PROSE, "empty-line"],
  [PROSE, "para-end"],
  [PROSE, "blank-run"],
  [PROSE, "last-para"],
  [CODE, "in-braces"],
];

const BRACKET_STARTS: readonly Start[] = [
  [BRACKETS, "outside"],
  [BRACKETS, "on-open"],
  [BRACKETS, "in-round"],
  [BRACKETS, "in-square"],
  [BRACKETS, "in-curly"],
  [BRACKETS, "on-close"],
  [BRACKETS, "multi-open"],
  [BRACKETS, "multiline"],
  [BRACKETS, "multi-close"],
  [BRACKETS, "second-block"],
  [BRACKETS, "tag"],
  [CODE, "in-parens"],
];

/**
 * vim.js falls back to searching forward with `new RegExp("\\<")` when the cursor isn't inside
 * angle brackets, which CodeMirror's unicode-mode regexp cursor rejects: the key throws. Only
 * starts inside `<…>` are vectors; `THROWING_STARTS` are checked to still throw instead.
 */
const ANGLE_STARTS: readonly Start[] = [
  [BRACKETS, "in-angle"],
  [BRACKETS, "angle-open"],
  [BRACKETS, "angle-close"],
  [BRACKETS, "closing-tag"],
  [BRACKETS, "self-closing"],
];

const ANGLE_THROWING_STARTS: readonly Start[] = [
  [BRACKETS, "tag"],
  [BRACKETS, "outside"],
];

const QUOTE_STARTS: readonly Start[] = [
  [BRACKETS, "in-single"],
  [BRACKETS, "on-quote"],
  [BRACKETS, "in-double"],
  [BRACKETS, "in-back"],
  [BRACKETS, "outside"],
  [CODE, "in-string"],
  [CODE, "in-single"],
];

const GROUPS: ReadonlyArray<readonly [readonly string[], readonly Start[]]> = [
  [["w", "W"], WORD_STARTS],
  [["s"], SENTENCE_STARTS],
  [["p"], PARAGRAPH_STARTS],
  [["(", ")", "b", "[", "]", "{", "}", "B"], BRACKET_STARTS],
  [["<", ">"], ANGLE_STARTS],
  [['"', "'", "`"], QUOTE_STARTS],
];

const OPERATORS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["d", []],
  ["c", ["X<Esc>"]],
  ["y", []],
  ["v", ["<Esc>"]],
];

export function addTextObjects(catalog: Catalog): void {
  for (const object of ["<", ">"]) {
    for (const kind of ["i", "a"]) {
      for (const [doc, posName] of ANGLE_THROWING_STARTS) {
        catalog.throws({
          name: `textobject/d/${kind}${label(object)}/${doc.id}/${posName}`,
          reason:
            "vim.js builds /\\</ for a unicode-mode RegExp cursor when no enclosing <…> exists",
          doc: doc.text,
          at: doc.at[posName]!,
          steps: [`d${kind}${object}`],
        });
      }
    }
  }
  for (const [objects, starts] of GROUPS) {
    for (const object of objects) {
      for (const kind of ["i", "a"]) {
        for (const [op, after] of OPERATORS) {
          for (const [doc, posName] of starts) {
            const at = doc.at[posName]!;
            catalog.add({
              name: `textobject/${op}/${kind}${label(object)}/${doc.id}/${posName}`,
              doc: doc.text,
              at,
              steps: [`${op}${kind}${object}`, ...after],
            });
          }
        }
      }
    }
  }

  // Counts select more words/sentences/paragraphs, or outer blocks.
  const counted: ReadonlyArray<readonly [string, Start]> = [
    ["d2aw", [WORDS, "bof"]],
    ["d3iw", [WORDS, "mid-word"]],
    ["c2iW", [PUNCT, "bof"]],
    ["y2as", [PROSE, "bof"]],
    ["d2ap", [PROSE, "bof"]],
    ["d2i(", [BRACKETS, "in-curly"]],
    ["d2a[", [BRACKETS, "in-curly"]],
    ["v2i{", [BRACKETS, "in-curly"]],
    ["2dab", [BRACKETS, "in-square"]],
  ];
  for (const [keys, [doc, posName]] of counted) {
    catalog.add({
      name: `textobject/count/${label(keys)}/${doc.id}/${posName}`,
      doc: doc.text,
      at: doc.at[posName]!,
      steps: [keys, ...(keys.startsWith("c") ? ["X<Esc>"] : keys.startsWith("v") ? ["<Esc>"] : [])],
    });
  }

  // In visual mode, repeating a text object extends the selection.
  for (const [id, keys, start] of [
    ["words", ["viw", "iw", "iw"], [WORDS, "mid-word"]],
    ["a-words", ["vaw", "aw"], [WORDS, "bof"]],
    ["blocks", ["vi(", "a(", "a("], [BRACKETS, "in-curly"]],
    ["sentences", ["vis", "is"], [PROSE, "bof"]],
    ["paragraphs", ["vip", "ip"], [PROSE, "bof"]],
    ["linewise-then-word", ["V", "iw"], [WORDS, "mid-word"]],
  ] as const) {
    const [doc, posName] = start;
    catalog.add({
      name: `textobject/visual-extend/${id}`,
      doc: doc.text,
      at: doc.at[posName]!,
      steps: [...keys, "d"],
    });
  }
}
