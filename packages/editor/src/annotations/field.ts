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

function mapAnnotations(
  value: AnnotationState,
  changes: ChangeSet,
  oldDoc: Text,
  newDoc: Text,
): AnnotationState {
  const deletions: Array<[number, number]> = [];
  changes.iterChangedRanges((fromA, toA) => {
    if (toA > fromA) deletions.push([fromA, toA]);
  });
  const entries: AnchoredAnnotation[] = [];
  for (const entry of value.entries) {
    if (deletions.length > 0) {
      const line = oldDoc.lineAt(entry.anchor);
      if (deletions.some(([from, to]) => from <= line.from && to >= line.to)) continue;
    }
    const anchor = changes.mapPos(entry.anchor, 1);
    entries.push(anchor === entry.anchor ? entry : { ...entry, anchor });
  }
  if (entries.length === 0) return EMPTY;
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
