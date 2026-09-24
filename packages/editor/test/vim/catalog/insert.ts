/** Entering insert mode, the insert-mode keys vim.js handles, counts, and replace mode. */
import { type Catalog, label, register } from "./builder";
import { BLANK, type Doc, INDENTED, SINGLE, TABS, UNICODE, WORDS } from "./docs";

const ENTRIES = ["i", "a", "I", "A", "o", "O", "gi", "gI", "s", "S", "C", "cc", "R"] as const;

const ENTRY_STARTS: ReadonlyArray<readonly [Doc, string]> = [
  [WORDS, "bof"],
  [WORDS, "mid-word"],
  [WORDS, "eol"],
  [WORDS, "eof"],
  [INDENTED, "four-spaces"],
  [INDENTED, "tab-start"],
  [BLANK, "empty"],
  [BLANK, "spaces"],
  [UNICODE, "emoji"],
  [SINGLE, "mid"],
];

export function addInsert(catalog: Catalog): void {
  for (const entry of ENTRIES) {
    for (const [doc, posName] of ENTRY_STARTS) {
      const at = doc.at[posName]!;
      const base = `insert/${label(entry)}/${doc.id}/${posName}`;
      catalog.add({ name: base, doc: doc.text, at, steps: [entry, "ab c", "<Esc>", "u"] });
      catalog.add({
        name: `${base}/count-3`,
        doc: doc.text,
        at,
        steps: [`3${entry}`, "xy", "<Esc>", "u"],
      });
      catalog.add({
        name: `${base}/repeat`,
        doc: doc.text,
        at,
        steps: [entry, "ok", "<Esc>", "j", ".", "2."],
      });
    }
  }

  // `gi` returns to where insert mode was last left.
  catalog.add({
    name: "insert/gi/after-edit",
    doc: WORDS.text,
    at: [0, 4],
    steps: ["ifoo<Esc>", "G$", "gibar<Esc>"],
  });

  // Keys the engine handles in insert mode.
  const text = "alpha beta gamma\n\tindented line\nlast";
  const insertKeys: ReadonlyArray<readonly [string, readonly [number, number], readonly string[]]> =
    [
      ["C-w/mid-line", [0, 11], ["a", "<C-w>", "<C-w>", "<Esc>"]],
      ["C-w/after-space", [0, 5], ["a", "<C-w>", "<Esc>"]],
      ["C-w/line-start", [1, 0], ["i", "<C-w>", "<Esc>"]],
      ["C-w/typed-text", [2, 3], ["a one two", "<C-w>", "<Esc>"]],
      ["C-u/mid-line", [0, 11], ["a", "<C-u>", "<Esc>"]],
      ["C-u/indented", [1, 5], ["a", "<C-u>", "<Esc>"]],
      ["C-u/typed-text", [2, 3], ["axyz", "<C-u>", "<Esc>"]],
      ["C-t/indent", [0, 3], ["i", "<C-t>", "<C-t>", "<Esc>"]],
      ["C-d/dedent", [1, 3], ["i", "<C-d>", "<C-d>", "<Esc>"]],
      ["C-o/one-command", [0, 0], ["i", "<C-o>", "w", "X", "<Esc>"]],
      ["C-o/dd", [1, 2], ["a", "<C-o>", "dd", "Y", "<Esc>"]],
      ["C-o/count", [0, 0], ["i", "<C-o>", "2w", "Z", "<Esc>"]],
      ["C-o/visual", [0, 0], ["i", "<C-o>", "v", "e", "d", "<Esc>"]],
      ["C-o/escape", [0, 2], ["i", "<C-o>", "<Esc>", "Q", "<Esc>"]],
      ["C-r/named", [0, 5], ["i", "<C-r>", "a", "<Esc>"]],
      ["C-r/unnamed", [0, 5], ["yiw", "A ", "<C-r>", '"', "<Esc>"]],
      ["C-r/small-delete", [0, 0], ["dw", "A", "<C-r>", "-", "<Esc>"]],
      ["C-r/last-insert", [0, 0], ["ifoo", "<Esc>", "A", "<C-r>", ".", "<Esc>"]],
      ["C-r/last-ex", [0, 0], [":noh<CR>", "A", "<C-r>", ":", "<Esc>"]],
      ["C-r/last-search", [0, 0], ["/beta<CR>", "A", "<C-r>", "/", "<Esc>"]],
      ["C-r/empty-register", [0, 0], ["i", "<C-r>", "z", "q", "<Esc>"]],
      ["C-r/linewise", [0, 0], ["yy", "A", "<C-r>", "0", "<Esc>"]],
      ["C-r/then-escape", [0, 0], ["i", "<C-r>", "<Esc>", "<Esc>"]],
      ["Ins/toggle-replace", [0, 0], ["i", "<Ins>", "XY", "<Ins>", "Z", "<Esc>"]],
      ["C-bracket/escape", [0, 3], ["ifoo", "<C-[>", "x"]],
      ["C-c/escape", [0, 3], ["ifoo", "<C-c>", "x"]],
      ["C-Esc/escape", [0, 3], ["ifoo", "<C-Esc>", "x"]],
      ["BS/typed", [0, 5], ["a", "xyz", "<BS>", "<BS>", "<Esc>"]],
      ["BS/join-lines", [1, 0], ["i", "<BS>", "<Esc>"]],
      ["BS/document-start", [0, 0], ["i", "<BS>", "<Esc>"]],
      ["Del/forward", [0, 0], ["i", "<Del>", "<Del>", "<Esc>"]],
      ["Del/join-lines", [0, 15], ["a", "<Del>", "<Esc>"]],
      ["CR/split", [0, 5], ["i", "<CR>", "<Esc>"]],
      ["CR/indented", [1, 3], ["i", "<CR>", "x", "<Esc>"]],
      ["Tab/insert", [0, 0], ["i", "<Tab>", "<Esc>"]],
      ["Space/insert", [0, 4], ["a", "<Space>", "x", "<Esc>"]],
      ["arrows/ignored", [0, 0], ["i", "<Left>", "<Right>", "<Down>", "q", "<Esc>"]],
    ];
  for (const [id, at, steps] of insertKeys) {
    catalog.add({
      name: `insert/keys/${id}`,
      doc: text,
      at,
      registers: { a: register("REG") },
      steps,
    });
  }

  // Grapheme-aware deletion and unicode typing.
  for (const [posName, steps] of Object.entries({
    "BS-combining": ["A", "<BS>", "<Esc>"],
    "BS-emoji": ["A", "👍", "<BS>", "<Esc>"],
    "type-cjk": ["a", "漢字", "<Esc>", "u"],
    "type-emoji-repeat": ["i", "👨‍👩‍👧", "<Esc>", "j."],
    "Del-zwj": ["i", "<Del>", "<Esc>"],
  })) {
    catalog.add({ name: `insert/unicode/${posName}`, doc: UNICODE.text, at: [2, 9], steps });
  }
  catalog.add({
    name: "insert/unicode/BS-after-combining",
    doc: UNICODE.text,
    at: [1, 1],
    steps: ["a", "<BS>", "<Esc>"],
  });

  // Replace mode.
  const replaceCases: Record<string, readonly string[]> = {
    basic: ["R", "XY", "<Esc>"],
    "past-line-end": ["R", "abcdefghijklmnop", "<Esc>"],
    backspace: ["R", "XYZ", "<BS>", "<BS>", "<Esc>"],
    "backspace-at-line-start": ["R", "<BS>", "<Esc>"],
    "enter-splits": ["R", "a", "<CR>", "b", "<Esc>"],
    delete: ["R", "<Del>", "Q", "<Esc>"],
    count: ["3R", "ab", "<Esc>"],
    repeat: ["R", "zz", "<Esc>", "w", "."],
    undo: ["R", "abc", "<Esc>", "u"],
    "ctrl-letter": ["R", "<C-a>", "<Esc>"],
    unicode: ["R", "é", "<Esc>"],
  };
  for (const [id, steps] of Object.entries(replaceCases)) {
    catalog.add({ name: `insert/replace/${id}`, doc: WORDS.text, at: [0, 4], steps });
  }
  catalog.add({
    name: "insert/replace/over-emoji",
    doc: UNICODE.text,
    at: [2, 0],
    steps: ["R", "x", "<Esc>"],
  });
  catalog.add({
    name: "insert/replace/over-tab",
    doc: TABS.text,
    at: [0, 1],
    steps: ["R", "x", "<Esc>"],
  });

  // Leaving insert mode moves the cursor left, but not past the line start.
  catalog.add({
    name: "insert/escape/line-start",
    doc: WORDS.text,
    at: [1, 0],
    steps: ["i", "<Esc>", "i", "<Esc>"],
  });
  catalog.add({
    name: "insert/escape/after-append-eol",
    doc: WORDS.text,
    at: [0, 0],
    steps: ["A", "<Esc>"],
  });

  // Counted inserts repeat the text (with newlines, BS and Del recorded for the repeat).
  for (const [id, steps] of Object.entries({
    "newline-text": ["2i", "a", "<CR>", "b", "<Esc>"],
    "with-backspace": ["3a", "xyz", "<BS>", "<Esc>"],
    "with-delete": ["2i", "<Del>", "q", "<Esc>"],
    "o-multiline": ["2o", "p", "<CR>", "q", "<Esc>"],
    "O-count": ["3O", "top", "<Esc>"],
    "A-then-dot": ["2A", "!", "<Esc>", "j", "."],
    "I-then-dot-count": ["I", "- ", "<Esc>", "j", "3."],
  })) {
    catalog.add({ name: `insert/count/${id}`, doc: WORDS.text, at: [0, 4], steps });
  }
}
