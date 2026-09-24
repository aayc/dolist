/**
 * Representative documents and starting positions for the catalog. Every text is synthetic. Each
 * doc names positions worth starting from (line starts and ends, empty and whitespace-only lines,
 * punctuation runs, tabs, combining marks, surrogate pairs, CJK).
 */

export type Pos = readonly [number, number];

export interface Doc {
  id: string;
  text: string;
  /** Named starting positions (0-based line, UTF-16 ch). */
  at: Record<string, Pos>;
}

function doc(id: string, lines: readonly string[], at: Record<string, Pos>): Doc {
  const text = lines.join("\n");
  for (const [name, [line, ch]] of Object.entries(at)) {
    const target = lines[line];
    if (target === undefined || ch > Math.max(0, target.length - 1)) {
      throw new Error(`${id}: position ${name} [${line}, ${ch}] is outside the text`);
    }
  }
  return { id, text, at };
}

export const WORDS = doc("words", ["one two three", "four five six", "seven eight nine"], {
  bof: [0, 0],
  "mid-word": [0, 5],
  "word-end": [1, 3],
  space: [1, 4],
  eol: [1, 12],
  "last-line": [2, 6],
  eof: [2, 15],
});

export const PUNCT = doc("punct", ["foo.bar(baz, qux); x+=1", "  a->b   c::d !!", "end."], {
  bof: [0, 0],
  dot: [0, 3],
  paren: [0, 7],
  comma: [0, 11],
  "op-run": [0, 20],
  indent: [1, 0],
  arrow: [1, 3],
  colons: [1, 10],
  bangs: [1, 14],
  "last-dot": [2, 3],
});

export const PROSE = doc(
  "prose",
  [
    "The quick brown fox. It jumps! Over the lazy dog?",
    "",
    "New paragraph here.  Second sentence.",
    "Still the same paragraph.",
    "",
    "",
    "Last paragraph. Done",
  ],
  {
    bof: [0, 0],
    "mid-sentence": [0, 10],
    "sentence-end": [0, 19],
    "after-bang": [0, 30],
    "empty-line": [1, 0],
    "second-para": [2, 4],
    "double-space": [2, 20],
    "para-end": [3, 10],
    "blank-run": [4, 0],
    "last-para": [6, 16],
  },
);

export const CODE = doc(
  "code",
  [
    "function f(a, b) {",
    "\tif (a) {",
    "\t\treturn [b, {c: 1}];",
    "\t}",
    "\treturn \"str\" + 'q';",
    "}",
  ],
  {
    bof: [0, 0],
    "open-paren": [0, 10],
    "in-parens": [0, 11],
    brace: [0, 17],
    "tab-indent": [1, 0],
    "after-tab": [1, 1],
    "in-brackets": [2, 10],
    "in-braces": [2, 14],
    "closing-brace": [3, 1],
    "in-string": [4, 10],
    "in-single": [4, 17],
    "last-brace": [5, 0],
  },
);

export const INDENTED = doc(
  "indented",
  ["  two spaces", "\tone tab", "    four spaces", "\t\ttwo tabs", "none"],
  {
    "space-indent": [0, 0],
    "after-spaces": [0, 2],
    "tab-start": [1, 0],
    "four-spaces": [2, 1],
    "two-tabs": [3, 1],
    unindented: [4, 2],
  },
);

export const BLANK = doc("blank", ["first line", "", "   ", "\t", "last line"], {
  first: [0, 3],
  empty: [1, 0],
  spaces: [2, 1],
  tab: [3, 0],
  last: [4, 4],
});

export const SINGLE = doc("single", ["just one line"], {
  bol: [0, 0],
  mid: [0, 6],
  eol: [0, 12],
});

export const EMPTY = doc("empty", [""], { bof: [0, 0] });

export const UNICODE = doc(
  "unicode",
  [
    "café naïve résumé",
    "e\u0301 cle\u0301 combining",
    "👍 emoji 👨‍👩‍👧 zwj ok",
    "日本語 テキスト 漢字",
    "mixed ñ中文x end",
  ],
  {
    accent: [0, 3],
    "second-word": [0, 5],
    combining: [1, 0],
    "combining-mid": [1, 5],
    emoji: [2, 0],
    "after-emoji": [2, 3],
    zwj: [2, 9],
    cjk: [3, 1],
    "cjk-second": [3, 4],
    mixed: [4, 6],
  },
);

export const NUMBERS = doc(
  "numbers",
  ["x 7 y", "-3 0x1f 0b101 010", "len: 99, 100", "v1.2.3 -0 9"],
  {
    before: [0, 0],
    on: [0, 2],
    negative: [1, 1],
    hex: [1, 5],
    binary: [1, 10],
    octal: [1, 15],
    "after-last": [2, 11],
    version: [3, 1],
    "minus-zero": [3, 8],
  },
);

export const BRACKETS = doc(
  "brackets",
  [
    "a (b [c {d} e] f) g",
    '<p class="v">text</p> <x/>',
    "'single' \"double\" `back`",
    "(",
    "  multi",
    "  line",
    ")",
    "if (a) { b(c); } else { d; }",
  ],
  {
    outside: [0, 0],
    "on-open": [0, 2],
    "in-round": [0, 3],
    "in-square": [0, 6],
    "in-curly": [0, 9],
    "on-close": [0, 16],
    tag: [1, 14],
    "in-angle": [1, 5],
    "angle-open": [1, 0],
    "angle-close": [1, 12],
    "closing-tag": [1, 19],
    "self-closing": [1, 23],
    "in-single": [2, 3],
    "on-quote": [2, 9],
    "in-double": [2, 12],
    "in-back": [2, 20],
    "multi-open": [3, 0],
    multiline: [4, 3],
    "multi-close": [6, 0],
    "second-block": [7, 24],
  },
);

export const TABS = doc("tabs", ["a\tb\tc", "\t\tindented", "x\t\ty", "tab at end\t"], {
  start: [0, 0],
  tab: [0, 1],
  "after-tab": [0, 2],
  "double-tab": [1, 1],
  inner: [2, 2],
  "trailing-tab": [3, 10],
});

/** Numbered lines for viewport and count cases (60 lines: 3 screens of 20 rows). */
export const LONG = doc(
  "long",
  Array.from({ length: 60 }, (_, i) =>
    i % 7 === 3
      ? ""
      : `line ${String(i).padStart(2, "0")} ${"word ".repeat(1 + (i % 5)).trimEnd()}`,
  ),
  { top: [0, 0], middle: [30, 5], bottom: [59, 0], "screen-2": [25, 3] },
);

export const MOTION_DOCS: readonly Doc[] = [
  WORDS,
  PUNCT,
  PROSE,
  CODE,
  INDENTED,
  BLANK,
  SINGLE,
  EMPTY,
  UNICODE,
  TABS,
];
