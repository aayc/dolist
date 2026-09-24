/** `.` repeat of every kind of edit (with counts), and undo/redo after each. */
import { type Catalog, label } from "./builder";

const TEXT = [
  "one two three four",
  "five six seven eight",
  "nine ten eleven",
  "twelve",
  "thirteen fourteen",
].join("\n");

/** Edits and the motion that moves to where the repeat is tried. */
const EDITS: ReadonlyArray<readonly [string, string]> = [
  ["x", "w"],
  ["X", "w"],
  ["3x", "j"],
  ["dw", "j"],
  ["d2w", "j0"],
  ["2dw", "j0"],
  ["dd", "j"],
  ["2dd", "gg"],
  ["D", "j"],
  ["cwNEW<Esc>", "w"],
  ["ciwZ<Esc>", "j"],
  ["C!<Esc>", "j"],
  ["ccline<Esc>", "j"],
  ["sS<Esc>", "w"],
  ["SS<Esc>", "j"],
  ["rZ", "w"],
  ["3rZ", "j"],
  ["~", "w"],
  ["g~w", "w"],
  ["gUiw", "j"],
  ["guu", "j"],
  ["J", "j"],
  ["gJ", "j"],
  [">>", "j"],
  ["<<", "j"],
  ["p", "j"],
  ["P", "j"],
  ["iins<Esc>", "w"],
  ["aapp<Esc>", "w"],
  ["IBOL<Esc>", "j"],
  ["AEOL<Esc>", "j"],
  ["onew<Esc>", "j"],
  ["Onew<Esc>", "j"],
  ["Rrep<Esc>", "j0"],
  ["<C-a>", "w"],
  ["3<C-x>", "w"],
  ["vld", "w"],
  ["vjd", "gg"],
  ["Vd", "j"],
  ["Vjd", "gg"],
  ["<C-v>jd", "w"],
  ["vU", "w"],
  ["v2l~", "w"],
  ["Vj>", "j"],
  ["vcX<Esc>", "w"],
  ["daw", "w"],
  ["dap", "gg"],
  ['"ayiw"ap', "w"],
];

export function addRepeat(catalog: Catalog): void {
  for (const [edit, move] of EDITS) {
    const base = `repeat/${label(edit)}`;
    catalog.add({ name: base, doc: TEXT, at: [0, 4], steps: [edit, move, ".", "u", "u", "<C-r>"] });
    catalog.add({ name: `${base}/count`, doc: TEXT, at: [0, 4], steps: [edit, move, "2.", "."] });
  }

  // Undo/redo details.
  for (const [id, steps] of Object.entries({
    "undo-insert": ["ifoo bar<Esc>", "u", "<C-r>"],
    "undo-count": ["x", "x", "x", "2u", "<C-r>"],
    "redo-count": ["x", "w", "x", "w", "x", "3u", "2<C-r>"],
    "undo-nothing": ["u", "x"],
    "redo-nothing": ["<C-r>", "x"],
    "undo-o-then-typing": ["ohello<Esc>", "u"],
    "undo-cursor-position": ["jdw", "gg", "u"],
    "undo-visual-block": ["<C-v>jlx", "u", "<C-r>"],
    "undo-after-dot": ["dw", ".", ".", "u", "u"],
    "undo-macro": ["qax jq", "@a", "u"],
    "undo-ex-substitute": [":%s/e/E/g<CR>", "u", "<C-r>"],
    "undo-join": ["3J", "u"],
    "ex-undo": ["x", "x", ":undo<CR>", ":redo<CR>"],
    "ex-u": ["dd", ":u<CR>", ":red<CR>"],
    "undo-insert-with-cursor-moves": ["ione", "<Esc>", "wiTWO", "<Esc>", "u"],
    "dot-without-edit": [".", "x"],
    "dot-after-undo": ["dw", "u", "."],
    "dot-after-motion": ["dw", "j", "l", "."],
    "dot-keeps-register": ['"adw', "w", ".", '"ap'],
    "dot-count-overrides": ["3x", "w", "."],
    "dot-count-remembered": ["x", "w", "3.", "w", "."],
    "dot-visual-extent": ["vjd", "."],
    "dot-after-insert-count": ["3ia<Esc>", "j."],
    "dot-o-count": ["2oxx<Esc>", "G."],
    "dot-C-w-in-insert": ["A one two<C-w><Esc>", "j."],
    "dot-C-u-in-insert": ["Anew<C-u><Esc>", "j."],
    "dot-C-r-in-insert": ["yiwA <C-r>0<Esc>", "j."],
    "dot-C-o-in-insert": ["ia<C-o>lb<Esc>", "j."],
  })) {
    catalog.add({ name: `undo/${id}`, doc: TEXT, at: [0, 4], steps });
  }
}
