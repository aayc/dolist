/** Visual, visual-line and visual-block mode: motions, operators, switching, `gv` and `:'<,'>`. */
import { type Catalog, label, register } from "./builder";
import { BRACKETS, INDENTED, PROSE, UNICODE } from "./docs";

const TEXT = ["one two three", "four five six", "seven eight nine", "ten", "eleven twelve"].join(
  "\n",
);
/** Ragged lines (a short one and an empty one) for block mode. */
const BLOCK = ["abcdefgh", "ijklmnop", "qrst", "uvwxyzAB", "", "CDEFGHIJ"].join("\n");

const MODES = [
  ["v", "v"],
  ["V", "V"],
  ["block", "<C-v>"],
] as const;

const MOTIONS = [
  "l",
  "h",
  "j",
  "2j",
  "k",
  "w",
  "3w",
  "e",
  "b",
  "$",
  "0",
  "^",
  "G",
  "gg",
  "}",
  ")",
  "fe",
  "te",
  "iw",
  "aw",
  "o",
  "O",
  "H",
  "L",
  "*",
  "/ven<CR>",
] as const;

const OPERATORS = [
  ["d", []],
  ["x", []],
  ["X", []],
  ["D", []],
  ["c", ["Z<Esc>"]],
  ["s", ["Z<Esc>"]],
  ["C", ["Z<Esc>"]],
  ["S", ["Z<Esc>"]],
  ["R", ["Z<Esc>"]],
  ["y", []],
  ["Y", []],
  [">", []],
  ["<", []],
  ["~", []],
  ["u", []],
  ["U", []],
  ["g~", []],
  ["gu", []],
  ["gU", []],
  ["g?", []],
  ["J", []],
  ["gJ", []],
  ["p", []],
  ["P", []],
  ["rx", []],
  ["I", ["Z<Esc>"]],
  ["A", ["Z<Esc>"]],
  ["<Esc>", []],
  [":", ["<Esc>"]],
] as const;

/** Selections each operator is applied to: [start, keys that extend the selection]. */
const EXTENTS: ReadonlyArray<readonly [string, readonly [number, number], string]> = [
  ["word", [0, 4], "e"],
  ["lines", [1, 5], "j"],
  ["backwards", [2, 8], "kb"],
  ["to-eol", [0, 8], "$"],
];

export function addVisual(catalog: Catalog): void {
  // Motions extend the selection; <Esc> leaves the cursor at the head.
  for (const [modeId, modeKeys] of MODES) {
    const doc = modeId === "block" ? BLOCK : TEXT;
    for (const motion of MOTIONS) {
      for (const [posName, at] of [
        ["start", [0, 2]],
        ["middle", [1, 5]],
        ["last-line", [4, 3]],
      ] as const) {
        catalog.add({
          name: `visual/${modeId}/motion/${label(motion)}/${posName}`,
          doc,
          at,
          steps: [modeKeys, motion, "<Esc>"],
        });
      }
    }
  }

  // Operators on a selection, then undo.
  for (const [modeId, modeKeys] of MODES) {
    const doc = modeId === "block" ? BLOCK : TEXT;
    for (const [op, after] of OPERATORS) {
      for (const [extentId, at, extend] of EXTENTS) {
        catalog.add({
          name: `visual/${modeId}/operator/${label(op)}/${extentId}`,
          doc,
          at,
          registers: { a: register("REG"), b: register("LINE\n", true) },
          steps: [`${modeKeys}${extend}`, op, ...after, "u"],
        });
      }
    }
  }

  // Counts in visual mode.
  for (const [id, keys] of Object.entries({
    "count-v": ["3v", "<Esc>"],
    "count-indent": ["Vj", "3>"],
    "count-dedent": ["Vj", ">>", "Vj", "2<"],
    "count-tilde": ["v", "2~"],
    "count-motion": ["v3l", "d"],
    "count-J": ["V", "3J"],
    "count-paste": ["yiw", "wv", "3p"],
  })) {
    catalog.add({ name: `visual/count/${id}`, doc: TEXT, at: [0, 0], steps: keys });
  }

  // Switching between visual modes, and leaving by the same key.
  for (const [from, fromKeys] of MODES) {
    for (const [to, toKeys] of MODES) {
      catalog.add({
        name: `visual/switch/${from}-to-${to}`,
        doc: TEXT,
        at: [1, 2],
        steps: [`${fromKeys}jl`, toKeys, "d"],
      });
    }
  }
  catalog.add({ name: "visual/switch/C-q", doc: BLOCK, at: [0, 1], steps: ["<C-q>jl", "d"] });

  // gv reselects the previous visual selection (also after edits and in another mode).
  for (const [id, steps] of Object.entries({
    "after-escape": ["vjl", "<Esc>", "G", "gv", "d"],
    "after-line": ["Vj", "<Esc>", "gg", "gv", "d"],
    "after-block": ["<C-v>jl", "<Esc>", "gg", "gv", "d"],
    "after-edit-above": ["jvl", "<Esc>", "ggO", "new<Esc>", "gv", "d"],
    "swap-in-visual": ["vl", "<Esc>", "jvl", "gv", "d"],
    "nothing-yet": ["gv", "x"],
    "after-operator": ["vjd", "gv", "<Esc>"],
  })) {
    catalog.add({ name: `visual/gv/${id}`, doc: TEXT, at: [0, 2], steps });
  }

  // Block mode specifics: `$`, I/A across ragged lines, c, r, o/O, block paste.
  for (const [id, steps] of Object.entries({
    "dollar-A": ["<C-v>3j$", "A", "!", "<Esc>"],
    "dollar-d": ["<C-v>2j$", "d"],
    "I-ragged": ["<C-v>3jl", "I", "> ", "<Esc>"],
    "A-ragged": ["<C-v>3jl", "A", "|", "<Esc>"],
    "A-past-short": ["<C-v>3jlll", "A", "#", "<Esc>"],
    "I-repeat": ["<C-v>jI", "-", "<Esc>", "jj.", "u"],
    "c-block": ["<C-v>jl", "c", "XY", "<Esc>"],
    "r-block": ["<C-v>2jl", "r*"],
    "o-then-d": ["<C-v>jl", "o", "h", "d"],
    "O-then-d": ["<C-v>jl", "O", "l", "d"],
    "y-then-p": ["<C-v>jl", "y", "G", "p"],
    "y-then-P": ["<C-v>jl", "y", "$", "P"],
    "yank-past-end": ["<C-v>jly", "4jp"],
    "x-empty-line": ["jjj<C-v>jjl", "x"],
    "shift-right": ["<C-v>jl", ">"],
    "shift-left": ["<C-v>jl", ">", "gv", "<"],
    "paste-over-block": ["yiw", "j<C-v>jl", "p"],
    "block-over-block": ["<C-v>jly", "l<C-v>jl", "p"],
    "J-block": ["<C-v>2j", "J"],
    "tilde-block": ["<C-v>2jl", "~"],
  })) {
    catalog.add({ name: `visual/block/${id}`, doc: BLOCK, at: [0, 1], steps });
  }
  catalog.add({
    name: "visual/block/o-O-o",
    doc: "abcd\nefgh\nijkl\nmnop",
    at: [0, 1],
    steps: ["<C-v>3jll", "o", "O", "o"],
  });
  catalog.add({
    name: "visual/gv/swap-block-twice",
    doc: "123456\nfoo\nbar",
    at: [1, 2],
    steps: ["<C-v>kh<C-v>", "2j", "vlgv", "gv", "<Esc>"],
  });
  catalog.add({
    name: "visual/block/tabs",
    doc: "\tab\n\tcd\n  ef",
    at: [0, 0],
    steps: ["<C-v>2jl", "d"],
  });
  catalog.add({
    name: "visual/block/unicode",
    doc: UNICODE.text,
    at: [0, 0],
    steps: ["<C-v>2jl", "d"],
  });

  // Ex commands on the selection: `:` opens with '<,'> prefilled.
  for (const [id, command] of Object.entries({
    substitute: "s/e/E/g",
    delete: "d",
    yank: "y",
    join: "j",
    sort: "sort",
    normal: "normal A;",
    global: "g/o/d",
    right: ">",
  })) {
    catalog.add({
      name: `visual/ex/${id}`,
      doc: TEXT,
      at: [1, 0],
      steps: ["Vj", ":", `${command}<CR>`],
    });
  }
  catalog.add({
    name: "visual/ex/charwise-substitute",
    doc: TEXT,
    at: [0, 4],
    steps: ["vjl", ":s/o/0/g<CR>"],
  });
  catalog.add({
    name: "visual/ex/marks",
    doc: TEXT,
    at: [1, 2],
    steps: ["vjl<Esc>", "gg", ":'<,'>d<CR>"],
  });

  // Paste over a selection puts the replaced text in the unnamed register.
  for (const [id, steps] of Object.entries({
    "charwise-over-word": ["yiw", "wviw", "p", "p"],
    "linewise-over-word": ["yy", "jviw", "p"],
    "charwise-over-lines": ["yiw", "jVj", "p"],
    "linewise-over-lines": ["yy", "jVj", "p"],
    "named-register": ["jviw", '"ap'],
    "P-keeps-register": ["yiw", "wviw", "P", "wviw", "P"],
  })) {
    catalog.add({
      name: `visual/paste/${id}`,
      doc: TEXT,
      at: [0, 0],
      registers: { a: register("REG") },
      steps,
    });
  }

  // Visual selections in other documents (brackets, prose, indentation, unicode).
  for (const [id, doc, at, steps] of [
    ["percent", BRACKETS.text, [0, 2], ["v%", "d"]],
    ["inner-paren", BRACKETS.text, [0, 9], ["vi(", "d"]],
    ["sentence", PROSE.text, [0, 22], ["vis", "d"]],
    ["paragraph", PROSE.text, [2, 0], ["vap", "d"]],
    ["indent-lines", INDENTED.text, [0, 0], ["V2j", ">", "gv", "<"]],
    ["unicode-word", UNICODE.text, [0, 5], ["viw", "U"]],
    ["unicode-emoji", UNICODE.text, [2, 0], ["vl", "d"]],
    ["surrogate-r", UNICODE.text, [2, 0], ["v", "rx"]],
  ] as const) {
    catalog.add({ name: `visual/docs/${id}`, doc, at, steps: [...steps] });
  }
}
