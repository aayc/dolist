/**
 * Activity chips: what the orchestrator is doing about a line, drawn after the line's last
 * character. Like badges, each chip is anchored to the START of its line (mapped with forward
 * association) and drawn at the end of whichever line holds the anchor. It remembers the line's
 * text when it was set and is dropped once an edit leaves the line unrecognizable
 * (`isSameLineEdited`), or when a single change removes the line's whole content. The cost per
 * transaction is one position map per chip, plus one comparison per chip on a changed line.
 */
import {
  type ChangeSet,
  type EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { isSameLineEdited } from "@ddl/core";
import type { ActivityChip } from "../types";
import { ActivityChipWidget, sameChip } from "./widget";

interface AnchoredChip {
  readonly chip: ActivityChip;
  /** Document position on the chip's line (initially its start). */
  readonly anchor: number;
  /** The line's text when the chip was set. */
  readonly baseline: string;
  readonly widget: Decoration;
}

export interface ActivityChipState {
  /** Sorted by anchor. */
  readonly entries: readonly AnchoredChip[];
  readonly decorations: DecorationSet;
  /** Chips were set since the state was created or last shown: later ones animate in. */
  readonly primed: boolean;
}

const EMPTY: ActivityChipState = { entries: [], decorations: Decoration.none, primed: false };
const EMPTY_PRIMED: ActivityChipState = { ...EMPTY, primed: true };

/** Replaces every chip. Lines are 0-based and refer to the state it is applied to. */
export const setActivityChipsEffect = StateEffect.define<readonly ActivityChip[]>();

/** Clears the chips of a state being shown again; the host's next set counts as its first. */
export const resetActivityChipsEffect = StateEffect.define<null>();

function buildDecorations(entries: readonly AnchoredChip[], doc: Text): DecorationSet {
  if (entries.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const entry of entries) {
    const { to } = doc.lineAt(entry.anchor);
    builder.add(to, to, entry.widget);
  }
  return builder.finish();
}

function placeChips(
  chips: readonly ActivityChip[],
  doc: Text,
  previous: ActivityChipState,
): ActivityChipState {
  const reusable = new Map(previous.entries.map((e) => [e.chip.id, e]));
  const entries: AnchoredChip[] = [];
  for (const chip of chips) {
    if (!Number.isInteger(chip.line) || chip.line < 0 || chip.line >= doc.lines) continue;
    const line = doc.line(chip.line + 1);
    if (line.text.trim() === "") continue;
    const old = reusable.get(chip.id);
    const widget =
      old && sameChip(old.chip, chip)
        ? old.widget
        : Decoration.widget({
            widget: new ActivityChipWidget(chip, !old && previous.primed),
            // After the line's badge (side 1), when it has one.
            side: 2,
          });
    entries.push({ chip, anchor: line.from, baseline: line.text, widget });
  }
  if (entries.length === 0) return EMPTY_PRIMED;
  entries.sort((a, b) => a.anchor - b.anchor);
  return { entries, decorations: buildDecorations(entries, doc), primed: true };
}

function mapChips(
  value: ActivityChipState,
  changes: ChangeSet,
  oldDoc: Text,
  newDoc: Text,
): ActivityChipState {
  /** `[fromA, toA]` of every change that deletes text. */
  const deletions: Array<[number, number]> = [];
  /** `[fromB, toB]` of every change, in the new document. */
  const touched: Array<[number, number]> = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (toA > fromA) deletions.push([fromA, toA]);
    touched.push([fromB, toB]);
  });
  const entries: AnchoredChip[] = [];
  for (const entry of value.entries) {
    const before = oldDoc.lineAt(entry.anchor);
    // The line itself went (deleted with its break, or joined away); a rewrite in place is judged
    // by its new text below.
    const gone = deletions.some(
      ([from, to]) =>
        from <= entry.anchor && to >= before.to && (from < entry.anchor || to > before.to),
    );
    if (gone) continue;
    // Anchors stay at their line's start, so text typed or pasted there stays on the line.
    const line = newDoc.lineAt(changes.mapPos(entry.anchor, 1));
    const edited = touched.some(([from, to]) => from <= line.to && to >= line.from);
    if (edited && !isSameLineEdited(entry.baseline, line.text)) continue;
    entries.push(line.from === entry.anchor ? entry : { ...entry, anchor: line.from });
  }
  if (entries.length === 0) return value.primed ? EMPTY_PRIMED : EMPTY;
  entries.sort((a, b) => a.anchor - b.anchor);
  // Rebuilt from the anchors: a widget mapped on its own would follow Enter onto the new line.
  return { entries, decorations: buildDecorations(entries, newDoc), primed: value.primed };
}

export const activityChipField = StateField.define<ActivityChipState>({
  create: () => EMPTY,
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.entries.length > 0) {
      next = mapChips(next, tr.changes, tr.startState.doc, tr.state.doc);
    }
    for (const effect of tr.effects) {
      if (effect.is(setActivityChipsEffect)) next = placeChips(effect.value, tr.state.doc, next);
      else if (effect.is(resetActivityChipsEffect)) next = EMPTY;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Current chips with their lines mapped through every edit since they were set. */
export function getActivityChips(state: EditorState): ActivityChip[] {
  const value = state.field(activityChipField, false);
  if (!value) return [];
  return value.entries.map((e) => ({ ...e.chip, line: state.doc.lineAt(e.anchor).number - 1 }));
}
