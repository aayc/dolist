/**
 * Inline formatting (Mod-b, Mod-i, Mod-k, …). Toggles act on the selection, or on the word at the
 * caret: markup already around the text is removed, otherwise it is added.
 */
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type StateCommand,
} from "@codemirror/state";

interface MarkupStyle {
  char: string;
  width: number;
  /** Characters to strip on each side, given the marker run around the text (0 = not applied). */
  strip(run: number): number;
}

const BOLD: MarkupStyle = { char: "*", width: 2, strip: (run) => (run >= 2 ? 2 : 0) };
// A run of 3 is bold + italic; a run of 2 is bold only, so italic is not active there.
const ITALIC: MarkupStyle = {
  char: "*",
  width: 1,
  strip: (run) => (run === 1 || run === 3 ? 1 : 0),
};
const STRIKETHROUGH: MarkupStyle = { char: "~", width: 2, strip: (run) => (run >= 2 ? 2 : 0) };
const HIGHLIGHT: MarkupStyle = { char: "=", width: 2, strip: (run) => (run >= 2 ? 2 : 0) };
const INLINE_CODE: MarkupStyle = { char: "`", width: 1, strip: (run) => (run >= 1 ? 1 : 0) };

const MAX_RUN = 3;

function leadingRun(text: string, char: string): number {
  let n = 0;
  while (n < text.length && text[n] === char) n++;
  return n;
}

function trailingRun(text: string, char: string): number {
  let n = 0;
  while (n < text.length && text[text.length - 1 - n] === char) n++;
  return n;
}

/** Length of the marker run directly around `[from, to]` on both sides (same lines only). */
function surroundingRun(state: EditorState, from: number, to: number, char: string): number {
  const before = state.sliceDoc(Math.max(state.doc.lineAt(from).from, from - MAX_RUN), from);
  const after = state.sliceDoc(to, Math.min(state.doc.lineAt(to).to, to + MAX_RUN));
  return Math.min(trailingRun(before, char), leadingRun(after, char), MAX_RUN);
}

function toggleMarkupRange(
  state: EditorState,
  range: SelectionRange,
  style: MarkupStyle,
): { changes: ChangeSpec; range: SelectionRange } {
  const marker = style.char.repeat(style.width);
  const word = range.empty ? state.wordAt(range.head) : null;
  const from = word ? word.from : range.from;
  const to = word ? word.to : range.to;

  if (!range.empty) {
    // The selection includes the markers: `«**bold**»`.
    const text = state.sliceDoc(from, to);
    const run = Math.min(leadingRun(text, style.char), trailingRun(text, style.char), MAX_RUN);
    const inner = style.strip(run);
    if (inner > 0 && text.length > inner * 2) {
      return {
        changes: [
          { from, to: from + inner },
          { from: to - inner, to },
        ],
        range: EditorSelection.range(from, to - inner * 2),
      };
    }
  }

  const strip = style.strip(surroundingRun(state, from, to, style.char));
  if (strip > 0) {
    return {
      changes: [
        { from: from - strip, to: from },
        { from: to, to: to + strip },
      ],
      range: EditorSelection.range(range.anchor - strip, range.head - strip),
    };
  }
  if (from === to) {
    return {
      changes: { from, insert: marker + marker },
      range: EditorSelection.cursor(from + marker.length),
    };
  }
  return {
    changes: [
      { from, insert: marker },
      { from: to, insert: marker },
    ],
    range: EditorSelection.range(range.anchor + marker.length, range.head + marker.length),
  };
}

function toggleMarkup(style: MarkupStyle): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const spec = state.changeByRange((range) => toggleMarkupRange(state, range, style));
    dispatch(state.update(spec, { userEvent: "input.format", scrollIntoView: true }));
    return true;
  };
}

/** Mod-b: `**bold**`. */
export const toggleBold = toggleMarkup(BOLD);
/** Mod-i: `*italic*`, aware of `**bold**` and `***both***`. */
export const toggleItalic = toggleMarkup(ITALIC);
export const toggleStrikethrough = toggleMarkup(STRIKETHROUGH);
export const toggleHighlight = toggleMarkup(HIGHLIGHT);
export const toggleInlineCode = toggleMarkup(INLINE_CODE);

const URL_LIKE = /^(?:[a-z][a-z\d+.-]*:\/\/|www\.|mailto:)\S+$/i;

/**
 * Mod-k. Selected text becomes `[text](|)`, a selected URL becomes `[|](url)`, and an empty
 * selection inserts `[|]()`.
 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const spec = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    if (range.empty) {
      return {
        changes: { from: range.from, insert: "[]()" },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    if (URL_LIKE.test(text.trim())) {
      return {
        changes: { from: range.from, to: range.to, insert: `[](${text.trim()})` },
        range: EditorSelection.cursor(range.from + 1),
      };
    }
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}]()` },
      range: EditorSelection.cursor(range.from + text.length + 3),
    };
  });
  dispatch(state.update(spec, { userEvent: "input", scrollIntoView: true }));
  return true;
};
