/** Viewport commands against the fixed 20-row viewport: H M L, z scrolling, <C-d>/<C-u>/…. */
import { type Catalog, label } from "./builder";
import { LONG } from "./docs";

const KEYS = [
  "H",
  "M",
  "L",
  "3H",
  "3L",
  "zt",
  "zz",
  "zb",
  "z<CR>",
  "z.",
  "z-",
  "<C-d>",
  "<C-u>",
  "5<C-d>",
  "5<C-u>",
  "<C-f>",
  "<C-b>",
  "2<C-f>",
  "<C-e>",
  "<C-y>",
  "3<C-e>",
  "3<C-y>",
  "<PageDown>",
  "<PageUp>",
  "dL",
  "yH",
  "dM",
];

/** [cursor, first visible line]. */
const STARTS: ReadonlyArray<readonly [string, readonly [number, number], number]> = [
  ["top", [0, 0], 0],
  ["screen-middle", [10, 3], 0],
  ["screen-bottom", [19, 0], 0],
  ["scrolled", [25, 5], 20],
  ["scrolled-top-edge", [20, 0], 20],
  ["last-screen", [55, 2], 40],
  ["last-line", [59, 0], 40],
];

export function addViewport(catalog: Catalog): void {
  for (const keys of KEYS) {
    for (const [id, at, scrollTop] of STARTS) {
      catalog.add({
        name: `viewport/${label(keys)}/${id}`,
        doc: LONG.text,
        at,
        scrollTop,
        steps: [keys, "u"],
      });
    }
  }
  // Scrolling follows the cursor: long motions, then viewport commands relative to the new screen.
  for (const [id, steps] of Object.entries({
    "G-then-H": ["G", "H"],
    "j-past-bottom": ["25j", "H"],
    "k-past-top": ["G", "25k", "L"],
    "search-offscreen": ["/line 45<CR>", "zt", "M"],
    "C-d-repeat-count": ["3<C-d>", "<C-d>"],
    "C-e-cursor-pushed": ["<C-e>", "<C-e>", "x"],
    "C-y-cursor-pushed": ["G", "<C-y>", "<C-y>"],
    "insert-scrolls": ["Gonew<Esc>", "H"],
  })) {
    catalog.add({ name: `viewport/follow/${id}`, doc: LONG.text, at: [0, 0], scrollTop: 0, steps });
  }
}
