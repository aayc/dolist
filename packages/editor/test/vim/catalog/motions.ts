/** Normal-mode motions from every interesting starting position, with and without counts. */
import { type Catalog, label } from "./builder";
import {
  BLANK,
  BRACKETS,
  CODE,
  type Doc,
  EMPTY,
  INDENTED,
  LONG,
  PROSE,
  PUNCT,
  SINGLE,
  TABS,
  UNICODE,
  WORDS,
} from "./docs";

interface Family {
  keys: readonly string[];
  docs: readonly Doc[];
  /** Counts tried from every position of the first `countDocs` docs. */
  counts: readonly number[];
  countDocs: number;
}

const FAMILIES: readonly Family[] = [
  {
    keys: ["w", "W", "b", "B", "e", "E", "ge", "gE"],
    docs: [WORDS, PUNCT, PROSE, UNICODE, CODE, INDENTED, BLANK, SINGLE, EMPTY, TABS],
    counts: [3],
    countDocs: 4,
  },
  {
    keys: ["h", "l", "<Space>", "<BS>", "<Left>", "<Right>", "0", "^", "$", "<Home>", "<End>"],
    docs: [WORDS, UNICODE, INDENTED, TABS, BLANK, SINGLE, EMPTY],
    counts: [2, 30],
    countDocs: 2,
  },
  {
    // Aliases for word motions and line motions.
    keys: ["<S-Space>", "<C-Space>", "<S-BS>", "<C-BS>"],
    docs: [WORDS, PUNCT],
    counts: [2],
    countDocs: 1,
  },
  {
    keys: ["|"],
    docs: [WORDS, TABS, UNICODE],
    counts: [1, 5, 99],
    countDocs: 3,
  },
  {
    keys: ["j", "k", "+", "-", "_", "<CR>", "<Up>", "<Down>", "<C-n>", "<C-p>"],
    docs: [WORDS, INDENTED, BLANK, UNICODE, TABS, SINGLE, EMPTY],
    counts: [2, 99],
    countDocs: 2,
  },
  {
    keys: ["gg", "G"],
    docs: [WORDS, INDENTED, BLANK, SINGLE, EMPTY],
    counts: [1, 2, 99],
    countDocs: 3,
  },
  {
    // Display-line motions are pixel based; the oracle doesn't wrap, and ASCII keeps them exact.
    keys: ["gj", "gk", "g0", "g^", "g$"],
    docs: [WORDS, INDENTED, TABS, CODE],
    counts: [2],
    countDocs: 1,
  },
  {
    keys: ["(", ")", "{", "}"],
    docs: [PROSE, CODE, BLANK, WORDS, SINGLE, EMPTY],
    counts: [2],
    countDocs: 2,
  },
  {
    keys: ["%"],
    docs: [BRACKETS, CODE, PUNCT, WORDS, EMPTY],
    counts: [],
    countDocs: 0,
  },
  {
    keys: [
      "[(",
      "[{",
      "])",
      "]}",
      "[[",
      "]]",
      "[]",
      "][",
      "[*",
      "]*",
      "[/",
      "]/",
      "[m",
      "]m",
      "[M",
      "]M",
      "[#",
      "]#",
    ],
    docs: [CODE, BRACKETS],
    counts: [2],
    countDocs: 1,
  },
];

/** f/F/t/T targets per doc; `;` and `,` repeat them in later steps. */
const FIND_TARGETS: ReadonlyArray<readonly [Doc, readonly string[]]> = [
  [WORDS, ["e", "o", " ", "z"]],
  [PUNCT, ["(", ",", ";", ".", ":"]],
  [PROSE, [".", "!", "T"]],
  [UNICODE, ["é", "e", "👍", "語", "\u0301"]],
  [TABS, ["\t", "c"]],
  [SINGLE, ["n"]],
  [EMPTY, ["x"]],
];

export function addMotions(catalog: Catalog): void {
  for (const family of FAMILIES) {
    family.docs.forEach((doc, docIndex) => {
      for (const [posName, at] of Object.entries(doc.at)) {
        for (const keys of family.keys) {
          const base = `motion/${label(keys)}/${doc.id}/${posName}`;
          catalog.add({ name: base, doc: doc.text, at, steps: [keys] });
          if (docIndex >= family.countDocs) continue;
          for (const count of family.counts) {
            catalog.add({
              name: `${base}/count-${count}`,
              doc: doc.text,
              at,
              steps: [`${count}${keys}`],
            });
          }
        }
      }
    });
  }

  for (const [doc, targets] of FIND_TARGETS) {
    for (const [posName, at] of Object.entries(doc.at)) {
      for (const target of targets) {
        for (const motion of ["f", "F", "t", "T"]) {
          catalog.add({
            name: `motion/${motion}/${doc.id}/${posName}/${label(target)}`,
            doc: doc.text,
            at,
            steps: [[motion, target], [";"], [","], ["2", ";"]],
          });
        }
      }
    }
    const [firstPos] = Object.values(doc.at);
    catalog.add({
      name: `motion/f/${doc.id}/count-2`,
      doc: doc.text,
      at: firstPos ?? [0, 0],
      steps: [
        ["2", "f", targets[0] ?? "x"],
        ["2", ","],
      ],
    });
  }

  // Counts larger than the document, and motions on the last screen of a long document.
  for (const keys of ["j", "k", "G", "gg", "}", "{", "w", "b"]) {
    for (const [posName, at] of Object.entries(LONG.at)) {
      catalog.add({
        name: `motion/${label(keys)}/long/${posName}/count-25`,
        doc: LONG.text,
        at,
        steps: [`25${keys}`],
      });
    }
  }

  // Aliases: <C-[>, <C-c> and <C-Esc> act as <Esc> outside insert mode, <Ins> enters insert mode,
  // <C-w> does nothing in normal mode, g<Up>/g<Down> are gk/gj.
  for (const [id, steps] of Object.entries({
    "C-bracket-visual": ["vl", "<C-[>", "x"],
    "C-c-visual": ["vl", "<C-c>", "x"],
    "C-Esc-visual": ["vl", "<C-Esc>", "x"],
    "C-c-operator": ["d", "<C-c>", "x"],
    "C-bracket-count": ["3", "<C-[>", "x"],
    "Ins-normal": ["<Ins>", "new", "<Esc>"],
    "C-w-normal": ["<C-w>", "x"],
    "g-Up": ["j", "g<Up>"],
    "g-Down": ["g<Down>"],
  })) {
    catalog.add({ name: `keys/${id}`, doc: WORDS.text, at: [0, 4], steps });
  }

  // Vertical motions remember the column (and `$` sticks to line ends).
  for (const [name, steps] of Object.entries({
    "keeps-column": ["j", "j", "j", "k"],
    "dollar-sticks": ["$", "j", "j", "k"],
    "column-after-short-line": ["l", "l", "l", "l", "l", "j", "j", "j"],
    "pipe-then-j": ["7|", "j", "j"],
    "goal-after-edit": ["$", "j", "x", "j"],
  })) {
    catalog.add({
      name: `motion/vertical/${name}`,
      doc: `${BLANK.text}\nanother long line`,
      at: [0, 6],
      steps,
    });
  }
}
