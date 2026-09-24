/**
 * Normal-mode edit commands: x X D C Y s S, r, ~, J/gJ, paste (p P ]p [p), <C-a>/<C-x>, gq/gw,
 * indentation with tab and space indent units.
 */
import { type Catalog, label, register } from "./builder";
import { BLANK, type Doc, INDENTED, NUMBERS, SINGLE, TABS, UNICODE, WORDS } from "./docs";

type Start = readonly [Doc, string];

const SIMPLE_STARTS: readonly Start[] = [
  [WORDS, "bof"],
  [WORDS, "mid-word"],
  [WORDS, "eol"],
  [WORDS, "eof"],
  [BLANK, "empty"],
  [BLANK, "spaces"],
  [SINGLE, "eol"],
  [UNICODE, "emoji"],
  [UNICODE, "combining"],
  [UNICODE, "cjk"],
  [TABS, "tab"],
];

const SIMPLE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["x", []],
  ["X", []],
  ["D", []],
  ["C", ["Q<Esc>"]],
  ["Y", ["P"]],
  ["s", ["Q<Esc>"]],
  ["S", ["Q<Esc>"]],
  ["~", []],
  ["J", []],
  ["gJ", []],
  ["rx", []],
  ["r<CR>", []],
  ["<Del>", []],
];

export function addEdits(catalog: Catalog): void {
  for (const [keys, after] of SIMPLE) {
    for (const [doc, posName] of SIMPLE_STARTS) {
      const at = doc.at[posName]!;
      const base = `edit/${label(keys)}/${doc.id}/${posName}`;
      catalog.add({ name: base, doc: doc.text, at, steps: [keys, ...after, "u"] });
      catalog.add({
        name: `${base}/count-3`,
        doc: doc.text,
        at,
        steps: [`3${keys}`, ...after, "u"],
      });
    }
  }

  // r with special targets.
  for (const [id, keys, at] of [
    ["count-past-eol", "9rz", [0, 10]],
    ["space", "r ", [0, 0]],
    ["tab", "r<Tab>", [0, 0]],
    ["unicode", "ré", [0, 0]],
    ["emoji", "r😀", [0, 0]],
    ["escape-cancels", "r<Esc>", [0, 0]],
    ["enter-count", "3r<CR>", [0, 4]],
    ["between-parens", "r<CR>", [0, 1]],
  ] as const) {
    catalog.add({
      name: `edit/r/special/${id}`,
      doc: "f(x) then text\nnext",
      at,
      steps: [keys, "u"],
    });
  }
  catalog.add({ name: "edit/r/surrogate-pair", doc: "😀x", at: [0, 0], steps: ["ru"] });

  // J on indented, blank, trailing-space and closing-paren lines.
  const joinDoc = ["a  ", "\t  b", "", "   ", "c", ")", "d)", "e"].join("\n");
  for (let line = 0; line < 7; line++) {
    for (const keys of ["J", "gJ", "3J", "3gJ"]) {
      catalog.add({
        name: `edit/join/${label(keys)}/line-${line}`,
        doc: joinDoc,
        at: [line, 0],
        steps: [keys, "u"],
      });
    }
  }

  // Paste: charwise, linewise, blockwise, counts, and ]p/[p indent matching.
  const pasteRegisters = {
    a: register("chars"),
    b: register("line one\n", true),
    c: register("ab\ncd", false, true),
    d: register("two\nlines\n", true),
    e: register("\tindented\n\t\tmore\n", true),
    f: register("multi\nline chars"),
  };
  const pasteDoc = ["first line", "\tsecond indented", "", "last"].join("\n");
  for (const reg of Object.keys(pasteRegisters)) {
    for (const keys of ["p", "P", "]p", "[p", "3p", "2P"]) {
      for (const [posName, at] of [
        ["bol", [0, 0]],
        ["indented", [1, 3]],
        ["empty", [2, 0]],
        ["eof", [3, 3]],
      ] as const) {
        catalog.add({
          name: `edit/paste/${reg}/${label(keys)}/${posName}`,
          doc: pasteDoc,
          at,
          registers: pasteRegisters,
          steps: [`"${reg}${keys}`, "u"],
        });
      }
    }
  }
  catalog.add({
    name: "edit/paste/empty-register",
    doc: pasteDoc,
    at: [0, 0],
    steps: ["p", '"zp'],
  });
  catalog.add({
    name: "edit/paste/unnamed-after-yank",
    doc: pasteDoc,
    at: [0, 0],
    steps: ["yw", "P", "$p"],
  });
  catalog.add({
    name: "edit/paste/linewise-last-line",
    doc: pasteDoc,
    at: [3, 0],
    steps: ["yy", "p", "P"],
  });
  catalog.add({
    name: "edit/paste/into-empty-doc",
    doc: "",
    at: [0, 0],
    registers: pasteRegisters,
    steps: ['"bp', "u", '"ap', "u", '"cp'],
  });

  // <C-a>/<C-x>: decimal, negative, hex, binary, octal-looking, counts, cursor before a number.
  for (const [posName, at] of Object.entries(NUMBERS.at)) {
    for (const keys of ["<C-a>", "<C-x>", "5<C-a>", "12<C-x>", "100<C-a>"]) {
      const input = {
        name: `edit/increment/${label(keys)}/${posName}`,
        doc: NUMBERS.text,
        at,
        steps: [keys, "."],
      };
      // A binary number that gains more than one digit makes vim.js zero-pad with a negative
      // `new Array(length)`.
      if (posName === "binary" && (keys === "12<C-x>" || keys === "100<C-a>")) {
        catalog.throws({
          ...input,
          reason: "vim.js pads a grown binary number with new Array(-n)",
        });
      } else {
        catalog.add(input);
      }
    }
  }
  catalog.add({
    name: "edit/increment/no-number",
    doc: "no digits here",
    at: [0, 3],
    steps: ["<C-a>", "<C-x>"],
  });
  catalog.add({
    name: "edit/increment/after-number",
    doc: "7 then text",
    at: [0, 5],
    steps: ["<C-a>"],
  });
  catalog.add({
    name: "edit/increment/crosses-zero",
    doc: "x 1 y",
    at: [0, 0],
    steps: ["3<C-x>", "5<C-a>"],
  });
  catalog.add({
    name: "edit/increment/hex-case",
    doc: "0xFF 0xff",
    at: [0, 0],
    steps: ["<C-a>", "w", "<C-a>"],
  });
  catalog.add({
    name: "edit/increment/big",
    doc: "9007199254740993",
    at: [0, 0],
    steps: ["<C-a>"],
  });

  // Indentation with tab and space indent units (>> << > < counts and motions).
  for (const [optionsId, options] of [
    ["tabs", undefined],
    ["two-spaces", { indentUnit: "  " }],
    ["four-spaces-tab8", { indentUnit: "    ", tabSize: 8 }],
  ] as const) {
    for (const [id, steps] of Object.entries({
      "shift-right": [">>"],
      "shift-left": ["<<"],
      "count-right": ["3>>"],
      "motion-right": [">j"],
      "motion-left": ["<2j"],
      "paragraph-right": [">ip"],
      twice: [">>", "."],
      "left-then-right": ["<<", ">>"],
      "insert-C-t": ["A", "<C-t>", "<Esc>"],
      "insert-C-d": ["A", "<C-d>", "<C-d>", "<Esc>"],
      "empty-line": ["jjj>>"],
    })) {
      catalog.add({
        name: `edit/indent/${optionsId}/${id}`,
        doc: INDENTED.text,
        at: [0, 3],
        ...(options ? { options } : {}),
        steps: [...steps, "u"],
      });
    }
  }
  catalog.add({
    name: "edit/indent/blank-lines",
    doc: BLANK.text,
    at: [0, 0],
    steps: [">G", "u", "<G"],
  });

  // gq/gw rewrap to textwidth (and join short lines).
  const wrapDoc = [
    "a long line that definitely needs wrapping at a small width",
    "short",
    "lines",
    "",
    "  indented long line with enough words to wrap twice over",
  ].join("\n");
  for (const [id, keys] of Object.entries({
    gqq: "gqq",
    gqip: "gqip",
    gqj: "gqj",
    gqG: "gqG",
    gwip: "gwip",
    "gq-visual": "Vjgq",
  })) {
    for (const width of [10, 20, 80]) {
      catalog.add({
        name: `edit/wrap/${id}/tw-${width}`,
        doc: wrapDoc,
        at: [0, 5],
        vim: { textwidth: width },
        steps: [keys],
      });
    }
  }
  catalog.add({
    name: "edit/wrap/indented",
    doc: wrapDoc,
    at: [4, 0],
    vim: { textwidth: 20 },
    steps: ["gqq"],
  });

  // Case changes on unicode and mixed text.
  for (const [id, keys] of Object.entries({
    "tilde-count": "10~",
    "g~w": "g~w",
    guu: "guu",
    gUiw: "gUiw",
    "g?g?": "g?g?",
    gU$: "gU$",
  })) {
    catalog.add({
      name: `edit/case/${label(id)}`,
      doc: "Straße ÉCOLE ǅ İ ﬁ ßß\nnext",
      at: [0, 0],
      steps: [keys, "u"],
    });
  }
}
