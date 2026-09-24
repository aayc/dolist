/**
 * Agent annotations: a badge after the last character of a task line plus a status line class.
 *
 * Each badge is anchored to the START of its line (mapped with forward association) and drawn at
 * the end of whichever line holds the anchor. Anchoring at the line end would make the badge follow
 * the text inserted by Enter at the end of a task onto the new, empty task. A badge is dropped when
 * a single change removes its line's entire content (line deleted, `dd`, cut, select-all-and-type).
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
import type { TaskAgentStatus } from "@ddl/core";
import type { LineAnnotation } from "../types";
import { BadgeWidget, sameAnnotation } from "./widget";

interface AnchoredAnnotation {
  readonly annotation: LineAnnotation;
  /** Document position on the annotated line (initially its start). */
  readonly anchor: number;
  readonly widget: Decoration;
}

export interface AnnotationState {
  /** Sorted by anchor. */
  readonly entries: readonly AnchoredAnnotation[];
  readonly decorations: DecorationSet;
}

const EMPTY: AnnotationState = { entries: [], decorations: Decoration.none };

/** Statuses that never get a badge. */
export const HIDDEN_BADGE_STATUSES: ReadonlySet<TaskAgentStatus> = new Set(["idle", "ignored"]);

/** Replaces the whole annotation set. Lines are 0-based and refer to the state it is applied to. */
export const setAnnotationsEffect = StateEffect.define<readonly LineAnnotation[]>();

const lineDecorationCache = new Map<TaskAgentStatus, Decoration>();

function lineDecoration(status: TaskAgentStatus): Decoration {
  let deco = lineDecorationCache.get(status);
  if (!deco) {
    deco = Decoration.line({ class: `cm-ddl-annotated cm-ddl-annotated-${status}` });
    lineDecorationCache.set(status, deco);
  }
  return deco;
}

function buildDecorations(entries: readonly AnchoredAnnotation[], doc: Text): DecorationSet {
  if (entries.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  let i = 0;
  while (i < entries.length) {
    const first = entries[i]!;
    const line = doc.lineAt(first.anchor);
    builder.add(line.from, line.from, lineDecoration(first.annotation.status));
    for (let entry = entries[i]; entry && entry.anchor <= line.to; entry = entries[++i]) {
      builder.add(line.to, line.to, entry.widget);
    }
  }
  return builder.finish();
}

function placeAnnotations(
  annotations: readonly LineAnnotation[],
  doc: Text,
  previous: AnnotationState,
): AnnotationState {
  const reusable = new Map(previous.entries.map((e) => [e.annotation.id, e]));
  const entries: AnchoredAnnotation[] = [];
  for (const annotation of annotations) {
    if (HIDDEN_BADGE_STATUSES.has(annotation.status)) continue;
    const { line } = annotation;
    if (!Number.isInteger(line) || line < 0 || line >= doc.lines) continue;
    const old = reusable.get(annotation.id);
    const widget =
      old && sameAnnotation(old.annotation, annotation)
        ? old.widget
        : Decoration.widget({ widget: new BadgeWidget(annotation), side: 1 });
    entries.push({ annotation, anchor: doc.line(line + 1).from, widget });
  }
  if (entries.length === 0) return EMPTY;
  entries.sort((a, b) => a.anchor - b.anchor);
  return { entries, decorations: buildDecorations(entries, doc) };
}

/**
 * Start positions (in the new document) of the whole lines a change set inserts, by line text.
 * Moving a line up/down deletes its neighbour and inserts it again on the other side.
 */
function insertedLines(changes: ChangeSet, newDoc: Text): Map<string, number[]> {
  const lines = new Map<string, number[]>();
  changes.iterChanges((_fromA, _toA, fromB, _toB, inserted) => {
    for (let n = 1; n <= inserted.lines; n++) {
      const part = inserted.line(n);
      if (!part.text.trim()) continue;
      const pos = fromB + part.from;
      const line = newDoc.lineAt(pos);
      if (line.from !== pos || line.text !== part.text) continue;
      const known = lines.get(part.text);
      if (known) known.push(pos);
      else lines.set(part.text, [pos]);
    }
  });
  return lines;
}

function mapAnnotations(
  value: AnnotationState,
  changes: ChangeSet,
  oldDoc: Text,
  newDoc: Text,
): AnnotationState {
  /** `[fromA, toA, toB]` of every change that deletes text. */
  const deletions: Array<[number, number, number]> = [];
  changes.iterChangedRanges((fromA, toA, _fromB, toB) => {
    if (toA > fromA) deletions.push([fromA, toA, toB]);
  });
  let reinserted: Map<string, number[]> | null = null;
  let reordered = false;
  const entries: AnchoredAnnotation[] = [];
  for (const entry of value.entries) {
    let replacedAt: number | undefined;
    if (deletions.length > 0) {
      const line = oldDoc.lineAt(entry.anchor);
      if (deletions.some(([from, to]) => from <= line.from && to >= line.to)) {
        // The whole line was removed: keep the badge only if the same change inserted that exact
        // line again (line moves, undoing them, external reorders).
        reinserted ??= insertedLines(changes, newDoc);
        const at = reinserted.get(line.text)?.shift();
        if (at === undefined) continue;
        entries.push({ ...entry, anchor: at });
        reordered = true;
        continue;
      }
      // mapPos keeps a position at the start of a replaced range before the insertion, which
      // would leave the badge on a line break inserted there instead of with the line's text.
      replacedAt = deletions.find(([from]) => from === entry.anchor)?.[2];
    }
    const anchor = replacedAt ?? changes.mapPos(entry.anchor, 1);
    entries.push(anchor === entry.anchor ? entry : { ...entry, anchor });
  }
  if (entries.length === 0) return EMPTY;
  if (reordered) entries.sort((a, b) => a.anchor - b.anchor);
  return { entries, decorations: buildDecorations(entries, newDoc) };
}

export const annotationField = StateField.define<AnnotationState>({
  create: () => EMPTY,
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.entries.length > 0) {
      next = mapAnnotations(next, tr.changes, tr.startState.doc, tr.state.doc);
    }
    for (const effect of tr.effects) {
      if (effect.is(setAnnotationsEffect))
        next = placeAnnotations(effect.value, tr.state.doc, next);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Current annotations with their lines mapped through every edit since they were set. */
export function getAnnotations(state: EditorState): LineAnnotation[] {
  const value = state.field(annotationField, false);
  if (!value) return [];
  return value.entries.map((e) => ({
    ...e.annotation,
    line: state.doc.lineAt(e.anchor).number - 1,
  }));
}

/** First annotation currently shown on a 0-based line. */
export function annotationAtLine(state: EditorState, line: number): LineAnnotation | null {
  if (line < 0 || line >= state.doc.lines) return null;
  const { from, to } = state.doc.line(line + 1);
  const value = state.field(annotationField, false);
  const entry = value?.entries.find((e) => e.anchor >= from && e.anchor <= to);
  return entry ? { ...entry.annotation, line } : null;
}
