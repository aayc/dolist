/** Ex commands: :s in every form, ranges, :g/:v, :sort, :normal, :d/:y/:j, :set, errors, history. */
import { type Catalog, cmd, label, register, type StepInput } from "./builder";

const TEXT = [
  "apple banana cherry",
  "banana split",
  "  cherry pie apple",
  "date 10 fig",
  "Apple 2 grape",
  "banana 1",
].join("\n");

const SORT_TEXT = ["b 10", "a 2", "C 1", "b 10", "0x1F x", "a -3", "", "B 007"].join("\n");

/**
 * Commands vim.js throws on while running them: the error is shown, and because the exception
 * escapes the prompt's keydown listener the prompt stays open until `<Esc>`.
 */
const THROWS_IN_COMMAND = new Set(["s/(/x/", "normal", "4,2d", "g//d", "set tw?=3"]);

function run(command: string): StepInput[] {
  return THROWS_IN_COMMAND.has(command) ? [cmd(command), "<Esc>"] : [cmd(command)];
}

export function addEx(catalog: Catalog): void {
  const substitute: Record<string, string> = {
    basic: "s/banana/BANANA/",
    global: "s/a/A/g",
    "whole-file": "%s/banana/B/g",
    "range-lines": "2,4s/a/_/g",
    "range-dot-dollar": ".,$s/banana/X/",
    "range-offset": ".,.+2s/^/> /",
    "range-negative-offset": "4;-1s/e/E/",
    "range-pattern": "/cherry/s/pie/tart/",
    "range-pattern-back": "?apple?s/apple/APPLE/",
    "range-pattern-pair": "/split/,/fig/s/$/;/",
    "count-arg": "s/a/A/g 3",
    "flag-i": "s/APPLE/pear/i",
    "flag-gi": "%s/BANANA/b/gi",
    "backref-whole": "s/banana/[$&]/",
    "backref-group": "s/(\\w+) (\\w+)/$2 $1/",
    "escaped-slash": "s/a/\\/\\//",
    "newline-replacement": "s/ /\\n/g",
    "tab-replacement": "s/ /\\t/",
    "empty-replacement": "s/banana //",
    "other-delimiter": "s#banana#nut#",
    "no-match": "s/zzz/y/",
    "invalid-regex": "s/(/x/",
    "missing-replacement": "s/banana",
    "bad-form": "s banana",
    "caret-anchor": "%s/^banana/B/",
    "dollar-anchor": "%s/apple$/A/",
    "nopcre-backref": "s/b\\(an\\)/\\1\\1/",
    "nopcre-amp": "s/an/<&>/g",
    "nopcre-very-magic": "s/\\v(an)+/X/",
  };
  for (const [id, command] of Object.entries(substitute)) {
    catalog.add({
      name: `ex/substitute/${id}`,
      doc: TEXT,
      at: [0, 0],
      ...(id.startsWith("nopcre") ? { vim: { pcre: false } } : {}),
      steps: [...run(command), "u"],
    });
  }
  // Reusing the last pattern and replacement.
  for (const [id, steps] of Object.entries({
    "empty-pattern": [":s/apple/X/<CR>", "j", ":s//Y/<CR>"],
    "search-pattern": ["/cherry<CR>", ":s//CH/<CR>"],
    "repeat-replacement": [":s/a/1/<CR>", "j", ":s/b<CR>"],
    "ampersand-not-command": [":s/a/1/<CR>", "j", ":&<CR>"],
    "tilde-not-command": [":s/a/1/<CR>", "j", ":~<CR>"],
    "at-colon-repeat": [":s/a/1/<CR>", "j", "@:"],
  })) {
    catalog.add({ name: `ex/substitute/reuse/${id}`, doc: TEXT, at: [0, 0], steps });
  }
  // Confirmation prompts.
  for (const [id, answers] of Object.entries({
    "yes-all": ["y", "y", "y", "y", "y", "y", "y", "y"],
    no: ["n", "y", "n", "y", "n", "n", "n"],
    all: ["a"],
    quit: ["y", "q"],
    last: ["n", "l"],
    escape: ["y", "<Esc>"],
    "C-c": ["<C-c>"],
    other: ["x", "z", "y", "<CR>"],
  })) {
    catalog.add({
      name: `ex/substitute/confirm/${id}`,
      doc: TEXT,
      at: [0, 0],
      steps: [cmd("%s/an/AN/gc"), ...answers.map((a) => [a]), "u"],
    });
  }

  const ranges: Record<string, string> = {
    "line-number": "3",
    "line-zero": "0",
    "past-end": "99",
    dollar: "$",
    "dot-plus": ".+2",
    plus: "+",
    minus: "4-",
    "pattern-forward": "/fig",
    "pattern-back": "?split",
    "delete-range": "2,3d",
    "delete-count-style": ".,.+1d",
    "delete-percent": "%d",
    "yank-range": "1,2y",
    "yank-register": "3y a",
    "join-range": "1,3j",
    "join-single": "4j",
    "normal-range": "2,4normal Ax",
    "normal-bang": "%normal! 0x",
    "normal-no-args": "normal",
    "reversed-range": "4,2d",
    "star-range": "*d",
  };
  for (const [id, command] of Object.entries(ranges)) {
    catalog.add({ name: `ex/range/${id}`, doc: TEXT, at: [1, 3], steps: run(command) });
  }
  // A count before `:` prefills `.,.+N`.
  catalog.add({ name: "ex/range/count-prefill", doc: TEXT, at: [0, 0], steps: ["3:", "d<CR>"] });

  const global: Record<string, string> = {
    delete: "g/banana/d",
    "inverse-v": "v/banana/d",
    "inverse-bang": "g!/a/d",
    substitute: "g/apple/s/a/A/g",
    normal: "g/banana/normal A!",
    "list-only": "g/banana",
    range: "2,4g/a/d",
    "no-match": "g/zzz/d",
    "empty-pattern": "g//d",
    "nested-deletes": "g/a/d",
    "join-each": "g/banana/j",
    "invalid-regex": "g/(/d",
    "missing-regex": "g",
  };
  for (const [id, command] of Object.entries(global)) {
    catalog.add({ name: `ex/global/${id}`, doc: TEXT, at: [0, 0], steps: [...run(command), "u"] });
  }
  catalog.add({
    name: "ex/global/after-search",
    doc: TEXT,
    at: [0, 0],
    steps: ["/cherry<CR>", ":g//d<CR>"],
  });

  const sorts: Record<string, string> = {
    plain: "sort",
    reverse: "sort!",
    "ignore-case": "sort i",
    numeric: "sort n",
    decimal: "sort d",
    unique: "sort u",
    "unique-ignore-case": "sort ui",
    hex: "sort x",
    octal: "sort o",
    pattern: "sort /\\w /",
    "pattern-r": "sort r /\\d+/",
    "reverse-numeric": "sort! n",
    range: "2,5sort",
    "invalid-flags": "sort z",
    "two-number-kinds": "sort nx",
    "trailing-garbage": "sort n foo",
  };
  for (const [id, command] of Object.entries(sorts)) {
    catalog.add({ name: `ex/sort/${id}`, doc: SORT_TEXT, at: [0, 0], steps: run(command) });
  }

  const misc: Record<string, readonly string[]> = {
    "delete-register": [":2d<CR>", "p"],
    "delete-last-line": [":$d<CR>"],
    "yank-default-register": [":2y<CR>", "p"],
    "join-count": [":j<CR>", ":j<CR>"],
    "put-default": ["yiw", ":put<CR>"],
    "put-bang": ["yy", ":put!<CR>"],
    "put-line": ["yy", ":4put<CR>"],
    "put-register": [":put q<CR>"],
    startinsert: [":startinsert<CR>", "x<Esc>"],
    "startinsert-bang": [":startinsert!<CR>", "x<Esc>"],
    nohlsearch: ["/an<CR>", ":nohlsearch<CR>", "n"],
    noh: [":noh<CR>"],
    write: [":w<CR>", ":write<CR>"],
    undo: ["x", ":u<CR>"],
    redo: ["x", "u", ":redo<CR>"],
    colorscheme: [":colo<CR>", ":colorscheme dark<CR>"],
    version: [":version<CR>"],
    "unknown-command": [":frobnicate<CR>"],
    "move-not-supported": [":m0<CR>"],
    "copy-not-supported": [":t.<CR>"],
    "shift-not-supported": [":><CR>"],
    "bang-not-supported": [":!ls<CR>"],
    "empty-command": [":<CR>", "x"],
    "leading-colons": ["::2<CR>"],
    "escape-cancels": [":2d", "<Esc>", "x"],
    "backspace-empty-cancels": [":", "<BS>", "x"],
    "C-u-clears": [":garbage", "<C-u>", "3<CR>"],
    "history-up": [":2<CR>", ":4<CR>", ":", "<Up>", "<Up>", "<CR>"],
    "history-prefix": [":2<CR>", ":$<CR>", ":2", "<Up>", "<CR>"],
    "history-down": [":2<CR>", ":4<CR>", ":", "<Up>", "<Up>", "<Down>", "<CR>"],
    "C-bracket-cancels": [":2", "<C-[>", "x"],
    "open-prompt": [":s/a"],
    "registers-dismiss": [":reg<CR>", "<CR>", "j"],
    "marks-dismiss-key": ["ma", ":marks<CR>", "x"],
  };
  for (const [id, steps] of Object.entries(misc)) {
    catalog.add({
      name: `ex/misc/${label(id)}`,
      doc: TEXT,
      at: [1, 2],
      registers: { q: register("from q") },
      steps,
    });
  }

  const set: Record<string, readonly string[]> = {
    "boolean-on": [":set pcre<CR>", ":set pcre?<CR>"],
    "boolean-off": [":set nopcre<CR>", ":set pcre?<CR>"],
    "boolean-toggle": [":set pcre!<CR>", ":set pcre?<CR>", ":set pcre!<CR>", ":se pcre?<CR>"],
    "boolean-value-error": [":set pcre=1<CR>"],
    "number-set": [":set tw=40<CR>", ":set tw?<CR>"],
    "number-get": [":set textwidth<CR>"],
    "number-alias": [":set textwidth=30<CR>", ":set tw?<CR>"],
    "unknown-option": [":set ignorecase<CR>"],
    "unknown-get": [":set frob?<CR>"],
    "trailing-question-value": [":set tw?=3<CR>", "<Esc>"],
    "no-args": [":set<CR>"],
    "insert-timeout": [
      ":set insertModeEscKeysTimeout=500<CR>",
      ":set insertModeEscKeysTimeout?<CR>",
    ],
    setlocal: [":setlocal tw=20<CR>", ":setl tw?<CR>", ":setglobal tw?<CR>"],
    setglobal: [":setglobal tw=50<CR>", ":setg tw?<CR>", ":set tw?<CR>"],
    langmap: [":set langmap=jk,kj<CR>", "j"],
  };
  for (const [id, steps] of Object.entries(set)) {
    catalog.add({ name: `ex/set/${id}`, doc: TEXT, at: [1, 2], steps });
  }
}
