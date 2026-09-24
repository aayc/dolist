/** Registers (named, append, black hole, numbered shift, small delete, 0 . : /) and macros. */
import { type Catalog, register } from "./builder";

const TEXT = ["alpha beta gamma", "delta epsilon", "zeta eta theta", "iota", "kappa lambda"].join(
  "\n",
);

export function addRegisters(catalog: Catalog): void {
  const cases: Record<string, readonly string[]> = {
    "named-yank": ['"ayiw', "w", '"ap'],
    "named-delete": ['"add', '"aP'],
    "uppercase-append": ['"ayiw', "w", '"Ayiw', "G", '"ap'],
    "uppercase-append-linewise": ['"ayiw', "j", '"Ayy', "G", '"ap'],
    "uppercase-from-empty": ['"Qyiw', '"qp'],
    "black-hole-delete": ["yiw", "w", '"_dw', "P"],
    "black-hole-yank": ['"_yy', "p"],
    "numbered-shift": ["dd", "dd", "dd", '"1p', '"2p', '"3p'],
    "numbered-ten-deletes": [
      "dd",
      "dd",
      "dd",
      "dd",
      "dd",
      "u",
      "u",
      "u",
      "u",
      "u",
      "dd",
      "dd",
      "dd",
      "dd",
      "dd",
      "dd",
      "dd",
      "dd",
      "dd",
      "dd",
    ],
    "small-delete": ["dw", "x", '"-p'],
    "small-delete-not-numbered": ["dw", '"1p'],
    "multiline-charwise-numbered": ["d/eta<CR>", '"1p'],
    "yank-zero": ["yiw", "dd", '"0p', "p"],
    "named-does-not-touch-zero": ["yiw", '"byy', '"0p'],
    "last-insert": ["ifoo<Esc>", '".p'],
    "last-insert-with-bs": ["ifoox<BS><Esc>", '".p'],
    "last-ex": [":s/a/A/<CR>", '":p'],
    "last-search": ["/eps<CR>", '"/P'],
    "search-register-updates": ["/eta<CR>", "*", '"/p'],
    "invalid-register": ['"!yy', "p"],
    "count-and-register": ['"a3yy', "G", '"ap'],
    "register-then-count": ['2"ayy', "G", '"ap'],
    "paste-count": ['"ayiw', '"a3p'],
    "unnamed-quote": ['""yiw', '""p'],
    "c-to-register": ['"acwX<Esc>', '"ap'],
    "x-to-register": ['"a3x', '"ap'],
    "visual-to-register": ['v2e"ay', "G", '"ap'],
    "insert-C-r-named": ['"ayiw', "o", "<C-r>", "a", "<Esc>"],
    "insert-C-r-numbered": ["dd", "O", "<C-r>", "1", "<Esc>"],
    "digit-register-yank": ['"5yy', '"5p'],
  };
  for (const [id, steps] of Object.entries(cases)) {
    catalog.add({ name: `register/${id}`, doc: TEXT, at: [0, 0], steps });
  }
  catalog.add({
    name: "register/preset-blockwise",
    doc: TEXT,
    at: [0, 2],
    registers: { x: register("12\n34", false, true) },
    steps: ['"xp', "u", '"xP'],
  });
  catalog.add({
    name: "register/ex-registers",
    doc: TEXT,
    at: [0, 0],
    registers: { a: register("one"), b: register("two\n", true) },
    steps: ["yiw", ":registers<CR>", "x", ":reg ab<CR>", "<CR>"],
  });
  catalog.add({
    name: "register/ex-put",
    doc: TEXT,
    at: [1, 0],
    registers: { a: register("put me") },
    steps: [":put a<CR>", ":2put! a<CR>", ":pu<CR>"],
  });

  // Macros.
  const macros: Record<string, readonly string[]> = {
    record: ["qa", "dwj", "q"],
    replay: ["qa", "dwj", "q", "@a"],
    "replay-count": ["qa", "xj", "q", "3@a"],
    "at-at": ["qa", "xj", "q", "@a", "@@"],
    "at-at-count": ["qa", "xj", "q", "@a", "2@@"],
    "with-insert": ["qa", "Ahi<Esc>j", "q", "@a", "@a"],
    "with-insert-newline": ["qa", "ofoo<CR>bar<Esc>", "q", "j@a"],
    "with-ex": ["qa", ":s/a/A/<CR>j", "q", "@a"],
    "with-search": ["qa", "/eta<CR>x", "q", "@a"],
    "with-visual": ["qa", "vex", "j", "q", "@a"],
    "append-uppercase": ["qa", "x", "q", "qA", "j", "q", "@a"],
    "register-content": ["qb", "dwjI-<Esc>", "q", '"bp'],
    "at-colon": [":s/e/E/g<CR>", "j", "@:"],
    "at-colon-count": [":s/a/A/<CR>", "j", "2@:"],
    "empty-register": ["@z", "x"],
    "record-escape-stops": ["qa", "x<Esc>q", "@a"],
    "dot-inside": ["qa", "xj.", "q", "@a"],
    "count-inside": ["qa", "2xj", "q", "@a"],
    "record-then-escape-q": ["qa", "q", "@a", "x"],
    "numbered-register": ["q1", "xj", "q", "@1"],
    "macro-undo": ["qa", "Ax<Esc>j", "q", "@a", "u"],
  };
  for (const [id, steps] of Object.entries(macros)) {
    catalog.add({ name: `macro/${id}`, doc: TEXT, at: [0, 0], steps });
  }
  catalog.throws({
    name: "macro/recursive",
    reason: "a macro that calls itself recurses until the JavaScript stack overflows",
    doc: TEXT,
    at: [0, 0],
    steps: ["qaq", "qa", "xj@a", "q", "@a"],
  });
}
