/**
 * Task commands. Like every command in this package they are `StateCommand`s, so they work with an
 * `EditorView` as well as with a plain `{ state, dispatch }` pair.
 */
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Line,
  type StateCommand,
  type Transaction,
} from "@codemirror/state";
import { checklistChange, toggleTaskChange } from "../task-lines";

export interface CommandTarget {
  state: EditorState;
  dispatch: (transaction: Transaction) => void;
}

/** Lines touched by the selection, in document order. A range ending at a line start excludes it. */
export function selectedLines(state: EditorState): Line[] {
  const seen = new Set<number>();
  const lines: Line[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (!range.empty && last > first && state.doc.line(last).from === range.to) last--;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  return lines.sort((a, b) => a.number - b.number);
}

/**
 * Obsidian's "Toggle checkbox status" (Mod-l / Mod-Enter) on every selected line: plain text →
 * `- [ ] text`, list item → task, `[ ]` ↔ `[x]` (other statuses become `[x]`).
 */
export const toggleChecklist: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const lines = selectedLines(state);
  const allowBlank = lines.length === 1;
  const specs: ChangeSpec[] = [];
  for (const line of lines) {
    const spec = checklistChange(line, allowBlank);
    if (spec) specs.push(spec);
  }
  if (specs.length === 0) return false;
  const changes = state.changes(specs);
  // Carets move past an inserted `- [ ] `; selections grow to include it.
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => {
      if (r.empty) return EditorSelection.cursor(changes.mapPos(r.head, 1));
      const forward = r.head >= r.anchor;
      return EditorSelection.range(
        changes.mapPos(r.anchor, forward ? -1 : 1),
        changes.mapPos(r.head, forward ? 1 : -1),
      );
    }),
    state.selection.mainIndex,
  );
  dispatch(state.update({ changes, selection, userEvent: "input.toggle", scrollIntoView: true }));
  return true;
};

/** Toggles the checkbox of the task on a 0-based line. No-op (false) for non-tasks or read-only. */
export function toggleTaskAtLine(target: CommandTarget, line: number): boolean {
  const { state } = target;
  if (!Number.isInteger(line) || line < 0 || line >= state.doc.lines) return false;
  return toggleTaskOnLine(target, state.doc.line(line + 1));
}

/** Toggles the checkbox of the task containing `pos` (used by the checkbox widget). */
export function toggleTaskAtPos(target: CommandTarget, pos: number): boolean {
  const { state } = target;
  if (pos < 0 || pos > state.doc.length) return false;
  return toggleTaskOnLine(target, state.doc.lineAt(pos));
}

function toggleTaskOnLine(target: CommandTarget, line: Line): boolean {
  const { state } = target;
  if (state.readOnly) return false;
  const change = toggleTaskChange(line);
  if (!change) return false;
  target.dispatch(state.update({ changes: change, userEvent: "input.toggle" }));
  return true;
}
