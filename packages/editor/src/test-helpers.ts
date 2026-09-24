/** Shared helpers for tests and benchmarks (not part of the public API). */
import { ensureSyntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  type EditorState,
  type StateCommand,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createHeadlessEditorState, type HeadlessStateOptions } from "./extensions";

/** Types like a user: each character goes through the view's input handlers (closeBrackets…). */
export function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    const insert = () =>
      view.state.update({
        changes: { from, to, insert: ch },
        selection: { anchor: from + ch.length },
        userEvent: "input.type",
      });
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view, from, to, ch, insert));
    if (!handled) view.dispatch(insert());
  }
}

/** A state whose syntax tree covers the whole document (headless states parse lazily). */
export function fullyParsed(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 10_000);
  // A no-op transaction adopts the tree the parse above produced.
  return state.update({}).state;
}

export function parsedState(doc: string, options: HeadlessStateOptions = {}): EditorState {
  return fullyParsed(createHeadlessEditorState(doc, options));
}

/** Runs a command against a state, returning the resulting state (or null if it declined). */
export function run(state: EditorState, command: StateCommand): EditorState | null {
  let next: EditorState | null = null;
  const handled = command({
    state,
    dispatch: (tr) => {
      next = tr.state;
    },
  });
  return handled ? next : null;
}

export function apply(state: EditorState, spec: TransactionSpec): EditorState {
  return fullyParsed(state.update(spec).state);
}

/** Builds a state from a doc where `|` marks the caret or `«…»` the selection. */
export function markedState(marked: string, options: HeadlessStateOptions = {}): EditorState {
  const doc = marked.replace(/[|«»]/g, "");
  const caret = marked.indexOf("|");
  const selFrom = marked.indexOf("«");
  const selection =
    caret >= 0
      ? EditorSelection.single(caret)
      : selFrom >= 0
        ? EditorSelection.single(selFrom, marked.indexOf("»") - 1)
        : EditorSelection.single(0);
  return parsedState(doc, { ...options, selection });
}

/** The document with `|` at the main caret or `«…»` around the main selection. */
export function showSelection(state: EditorState): string {
  const { from, to, empty } = state.selection.main;
  const doc = state.doc.toString();
  if (empty) return `${doc.slice(0, from)}|${doc.slice(from)}`;
  return `${doc.slice(0, from)}«${doc.slice(from, to)}»${doc.slice(to)}`;
}

/** Runs a command on a marked document; returns the marked result, or null if it declined. */
export function runMarked(marked: string, command: StateCommand): string | null {
  const next = run(markedState(marked), command);
  return next ? showSelection(next) : null;
}

/** A realistic daily note of `lines` lines (headings, tasks with links/tags/emphasis, notes, code). */
export function makeNote(lines: number): string {
  const out: string[] = [];
  for (let i = 0; out.length < lines; i++) {
    switch (i % 20) {
      case 0:
        out.push(`## Section ${i / 20}`);
        break;
      case 5:
        out.push(`> Quote ${i} with a [[Wiki link|alias]] and **bold** text`);
        break;
      case 9:
        out.push("```ts", `const value${i} = ${i};`, "```");
        break;
      case 13:
        out.push(`- note ${i}: see [docs](https://example.com/${i}) and \`code\``);
        break;
      default:
        out.push(
          `- [${i % 4 === 0 ? "x" : " "}] Task ${i}: follow up with [[Vendor ${i % 17}]] about *invoice* #finance ==today==`,
        );
    }
  }
  return out.slice(0, lines).join("\n");
}
