/** The :map family (per mode, recursive vs noremap, ex mappings) and using the mappings. */
import { type Catalog, cmd, type StepInput } from "./builder";

const TEXT = ["one two three", "four five six", "seven eight nine"].join("\n");

export function addMappings(catalog: Catalog): void {
  const cases: Record<string, readonly StepInput[]> = {
    "map-normal": [cmd("map Q dd"), "Q"],
    "map-applies-in-visual": [cmd("map Q d"), "vlQ"],
    "nmap-not-in-visual": [cmd("nmap Q x"), "vlQ", "<Esc>", "Q"],
    "vmap-only-visual": [cmd("vmap Q d"), "Q", "vlQ"],
    "imap-jj": [cmd("imap jj <Esc>"), "ifoojj", "x"],
    "imap-single-j": [cmd("imap jj <Esc>"), "ifooj", "k<Esc>"],
    "imap-to-text": [cmd("imap ;n hello"), "A;n<Esc>"],
    "imap-to-special": [cmd("imap <C-l> <Right>"), "i<C-l>X<Esc>"],
    "inoremap-cr": [cmd("inoremap ;; <CR>"), "A;;x<Esc>"],
    omap: [cmd("omap w $"), "dw", "w"],
    onoremap: [cmd("onoremap L $"), "dL"],
    "nmap-gj": [cmd("nmap j gj"), "j", "dj"],
    recursive: [cmd("map A B"), cmd("map B x"), "A"],
    "noremap-stops": [cmd("map B x"), cmd("noremap A B"), "A"],
    "nnoremap-default-keys": [cmd("nnoremap x dd"), cmd("nnoremap X x"), "X"],
    vnoremap: [cmd("vnoremap Q y"), "viwQ", "P"],
    "map-to-ex": [cmd("nmap Q :s/o/0/g<CR>"), "Q"],
    "map-to-ex-line": [cmd("nmap Q :2d<CR>"), "Q"],
    "map-leaves-prompt-open": [cmd("nmap Q :s/"), "Q"],
    "unmap-normal": [cmd("nmap Q x"), cmd("unmap Q"), "Q"],
    "unmap-missing": [cmd("unmap Q")],
    mapclear: [cmd("map Q x"), cmd("mapclear"), "Q"],
    "nmapclear-keeps-imap": [
      cmd("nmap Q x"),
      cmd("imap QQ <Esc>"),
      cmd("nmapclear"),
      "Q",
      "iaQQ",
      "x",
    ],
    vmapclear: [cmd("vmap Q d"), cmd("vmapclear"), "vlQ<Esc>"],
    imapclear: [cmd("imap jj <Esc>"), cmd("imapclear"), "ijj<Esc>"],
    omapclear: [cmd("omap w $"), cmd("omapclear"), "dw"],
    "map-invalid": [cmd("map Q")],
    "ex-to-ex": [cmd("map :foo :2d"), cmd("foo")],
    "ex-to-keys": [cmd("map :bar dd"), cmd("bar")],
    "ex-unmap": [cmd("map :foo :2d"), cmd("unmap :foo"), cmd("foo")],
    "ex-map-with-mode": [cmd("nmap :foo :bar"), "<Esc>"],
    "map-count": [cmd("map Q x"), "3Q"],
    "map-in-macro": [cmd("map Q xj"), "qaQq", "@a"],
    "map-then-dot": [cmd("map Q dw"), "Q", "."],
    "map-prefix-of-default": [cmd("nmap dx dd"), "dx", "dw"],
    "map-overrides-default": [cmd("nnoremap w b"), "$w"],
    "noremap-u-in-visual": [cmd("noremap Q u"), "x", "Q", "vlQ"],
    "map-space": [cmd("nmap <Space> dd"), "<Space>"],
    "normal-uses-map": [cmd("nmap Q x"), cmd("normal Q")],
    "normal-bang-ignores-map": [cmd("nmap x dd"), cmd("normal! x")],
  };
  for (const [id, steps] of Object.entries(cases)) {
    catalog.add({ name: `map/${id}`, doc: TEXT, at: [0, 4], steps });
  }
}
