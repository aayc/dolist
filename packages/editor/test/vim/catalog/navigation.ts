/** Marks, special marks, the jumplist, and search (/ ? n N * # g* g# gn gN, regex flavors). */
import { type Catalog, label } from "./builder";
import { LONG } from "./docs";

const TEXT = [
  "alpha beta gamma",
  "  delta Beta epsilon",
  "zeta eta theta",
  "",
  "iota beta.kappa",
  "lambda BETA mu",
].join("\n");

export function addNavigation(catalog: Catalog): void {
  const marks: Record<string, readonly string[]> = {
    "backtick-exact": ["ma", "G", "`a"],
    "quote-line": ["ma", "G", "'a"],
    "quote-first-nonblank": ["j$ma", "G", "'a"],
    "unset-mark": ["`z", "x"],
    "overwrite-mark": ["ma", "jma", "G", "`a"],
    "mark-follows-edit": ["jwma", "ggOnew line<Esc>", "`a"],
    "mark-on-deleted-line": ["jma", "dd", "gg", "`a"],
    "mark-in-deleted-text": ["wma", "0dw", "G", "`a"],
    "d-to-mark": ["ma", "2j", "d`a"],
    "d-line-to-mark": ["ma", "2j", "d'a"],
    "y-to-mark": ["wma", "j", "y`a", "P"],
    "c-to-mark": ["wwma", "0", "c`a", "X<Esc>"],
    "visual-to-mark": ["ma", "2jw", "v`a", "d"],
    "uppercase-mark": ["jmA", "G", "`A"],
    "special-lt-gt": ["jvjl<Esc>", "gg", "`<", "x", "`>", "x"],
    "special-lt-gt-line": ["jVj<Esc>", "gg", "'>", "x"],
    "special-dot": ["jAx<Esc>", "gg", "`.", "x"],
    "special-backtick": ["G", "``", "x"],
    "special-quote": ["G", "''", "x"],
    "next-mark": ["ma", "2jmb", "4jmc", "gg", "]`", "]`", "[`"],
    "next-mark-line": ["ma", "2jmb", "4jmc", "gg", "]'", "]'", "['"],
    "next-mark-count": ["ma", "2jmb", "4jmc", "gg", "2]`"],
    "ex-marks": ["ma", "jmb", ":marks<CR>", "<CR>"],
    "ex-marks-filter": ["ma", "jmb", ":marks b<CR>", "x"],
    "delmarks-one": ["ma", "jmb", ":delmarks a<CR>", "`a", "`b"],
    "delmarks-range": ["ma", "jmb", "jmc", ":delm a-b<CR>", "`b", "`c"],
    "delmarks-list": ["ma", "jmb", ":delm a b<CR>", "`b"],
    "delmarks-invalid": [":delmarks 1<CR>"],
    "delmarks-bad-range": [":delmarks b-a<CR>"],
    "delmarks-missing": [":delmarks<CR>"],
    "range-marks": ["ma", "2jmb", ":'a,'bd<CR>"],
    "range-unset-mark": [":'q,.d<CR>"],
  };
  for (const [id, steps] of Object.entries(marks)) {
    catalog.add({ name: `mark/${label(id)}`, doc: TEXT, at: [0, 6], steps });
  }

  const jumps: Record<string, readonly string[]> = {
    G: ["G", "<C-o>", "<C-i>"],
    gg: ["G", "gg", "<C-o>", "<C-o>", "<C-i>"],
    search: ["/eta<CR>", "n", "<C-o>", "<C-o>", "<C-i>"],
    star: ["*", "<C-o>"],
    percent: ["$", "%", "<C-o>"],
    paragraph: ["}", "}", "<C-o>", "<C-o>"],
    "mark-jump": ["2jma", "gg", "`a", "<C-o>"],
    "count-back": ["G", "gg", "G", "3<C-o>", "2<C-i>"],
    "after-edit": ["G", "gg", "dd", "<C-o>"],
    "tab-is-C-i": ["G", "<C-o>", "<Tab>"],
    "no-jumps": ["<C-o>", "<C-i>", "x"],
    "H-L": ["L", "H", "<C-o>", "<C-o>"],
  };
  for (const [id, steps] of Object.entries(jumps)) {
    catalog.add({ name: `jumplist/${label(id)}`, doc: TEXT, at: [1, 4], steps });
  }

  const search: Record<string, readonly string[]> = {
    forward: ["/eta<CR>", "n", "n", "N"],
    backward: ["?eta<CR>", "n", "N"],
    "wraps-forward": ["G", "/alpha<CR>"],
    "wraps-backward": ["?lambda<CR>"],
    "not-found": ["/zzz<CR>", "n"],
    "smartcase-lower": ["/beta<CR>", "n", "n", "n"],
    "smartcase-upper": ["/Beta<CR>", "n"],
    "flag-i": ["/Beta/i<CR>", "n"],
    "count-n": ["/a<CR>", "3n"],
    "count-search": ["3/eta<CR>"],
    "empty-reuses": ["/eta<CR>", "gg", "/<CR>"],
    "backward-empty": ["/eta<CR>", "G", "?<CR>"],
    "escape-cancels": ["/eta", "<Esc>", "x"],
    "backspace-empty-cancels": ["/", "<BS>", "x"],
    "backspace-edits": ["/etx", "<BS>", "a<CR>"],
    "C-u-clears": ["/zzz", "<C-u>", "mu<CR>"],
    "history-up": ["/eta<CR>", "/iota<CR>", "/", "<Up>", "<Up>", "<CR>"],
    "history-prefix": ["/eta<CR>", "/iota<CR>", "/e", "<Up>", "<CR>"],
    "history-down": ["/eta<CR>", "/iota<CR>", "/", "<Up>", "<Up>", "<Down>", "<CR>"],
    "regex-class": ["/[dz]eta<CR>", "n"],
    "regex-anchors": ["/^zeta<CR>", "/mu$<CR>"],
    "regex-dot-escape": ["/a\\.k<CR>"],
    "regex-alternation": ["/iota|mu<CR>"],
    "regex-word-boundary": ["/\\beta\\b<CR>"],
    "regex-digit-none": ["/\\d<CR>"],
    "regex-invalid": ["/(<CR>", "x"],
    "pcre-off-magic": [":set nopcre<CR>", "/\\<eta\\><CR>", "n"],
    "pcre-off-very-magic": [":set nopcre<CR>", "/\\v(zeta|iota)<CR>", "n"],
    "pcre-off-plain-parens": [":set nopcre<CR>", "/a (b<CR>"],
    "pcre-off-zs": [":set nopcre<CR>", "/delta \\zsBeta<CR>"],
    "star-word": ["*", "n", "#"],
    "star-whole-word": ["w*", "n"],
    "star-count": ["2*"],
    "hash-word": ["#", "n"],
    "g-star-partial": ["wg*", "n", "n"],
    "g-hash-partial": ["wg#", "n"],
    "star-non-word": ["j0*"],
    "star-punctuation": ["4j$h*"],
    "star-empty-line": ["3j*"],
    "gn-select": ["/eta<CR>", "gg", "gn", "<Esc>"],
    "gn-delete": ["/eta<CR>", "gg", "dgn", "."],
    "gn-change": ["/eta<CR>", "gg", "cgn", "ETA<Esc>", "."],
    "gN-select": ["/eta<CR>", "G", "gN", "d"],
    "gn-in-visual": ["/eta<CR>", "gg", "v", "gn", "d"],
    "gn-no-match": ["/zzz<CR>", "gn", "x"],
    "n-no-previous": ["n", "x"],
    "d-search": ["d/eps<CR>"],
    "c-search": ["c/eta<CR>", "X<Esc>"],
    "y-search-back": ["G", "y?eta<CR>", "P"],
    "search-offset-ignored": ["/eta/e<CR>"],
    "search-in-visual": ["v/eta<CR>", "d"],
    "search-then-dot": ["/eta<CR>", "x", "n", "."],
    "noh-then-n": ["/eta<CR>", ":noh<CR>", "n"],
  };
  for (const [id, steps] of Object.entries(search)) {
    catalog.add({ name: `search/${label(id)}`, doc: TEXT, at: [0, 0], steps });
  }
  catalog.add({
    name: "search/long-document-wrap",
    doc: LONG.text,
    at: [50, 0],
    steps: ["/line 02<CR>", "?line 55<CR>"],
  });
  catalog.add({
    name: "search/history-repeated-entry",
    doc: "",
    at: [0, 0],
    steps: [
      "/this<CR>",
      "/checks<CR>",
      "/search<CR>",
      "/history<CR>",
      "/checks<CR>",
      "/",
      "<Up>",
      "<Up>",
      "<Up>",
      "<Up>",
      "<Down>",
    ],
  });
}
