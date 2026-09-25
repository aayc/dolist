/**
 * The text edits behind moving, resizing, removing and inserting embeds. Pure: they take a state
 * and return the transaction to dispatch, so the same rules can be tested without a view. They
 * are the user's own edits (undoable, reported as user events).
 */
import type { EditorState, Text, TransactionSpec } from "@codemirror/state";
import { formatDrawingEmbed } from "@ddl/core";
import type { BlockEmbed, EmbedPlacement, EmbedSpec } from "./types";

/** An edit and where the embed's `![[` is afterwards. */
export interface EmbedEdit {
  spec: TransactionSpec;
  from: number;
}

export interface EmbedMove {
  /** 0-based index of the line the embed goes before; the line count puts it after the last line. */
  before: number;
  placement: EmbedPlacement;
}

export const MIN_EMBED_WIDTH = 48;

/** The embed with some modifiers changed, formatted the way the plugin reads it back. */
export function formatEmbed(embed: BlockEmbed, changes: Partial<EmbedSpec>): string {
  return formatDrawingEmbed({ ...embed.spec, ...changes });
}

/** The modifiers a placement implies: full width drops the width (the embed spans the column). */
function placementChanges(embed: BlockEmbed, placement: EmbedPlacement): Partial<EmbedSpec> {
  if (placement !== "full") return { placement };
  return {
    placement,
    width: undefined,
    height: undefined,
    widthPercent: undefined,
    heightPercent: undefined,
    style: embed.spec.placement === "full" ? embed.spec.style : undefined,
  };
}

/** The range that removes the embed's line with one line break. */
function lineRemoval(doc: Text, embed: BlockEmbed): { from: number; to: number } {
  if (embed.lineTo < doc.length) return { from: embed.lineFrom, to: embed.lineTo + 1 };
  if (embed.lineFrom > 0) return { from: embed.lineFrom - 1, to: embed.lineTo };
  return { from: 0, to: doc.length };
}

/**
 * Moves the embed's line so it goes before line `before`, with `placement`. Dropping it next to
 * its own line only changes the placement. Null when nothing changes.
 */
export function moveEmbed(
  state: EditorState,
  embed: BlockEmbed,
  move: EmbedMove,
): EmbedEdit | null {
  const { doc } = state;
  const line = doc.lineAt(embed.lineFrom).number - 1;
  const before = Math.min(Math.max(Math.floor(move.before), 0), doc.lines);
  const text = formatEmbed(embed, placementChanges(embed, move.placement));
  if (before === line || before === line + 1) {
    if (text === embed.text) return null;
    return {
      spec: {
        changes: { from: embed.from, to: embed.to, insert: text },
        userEvent: "input.embed",
      },
      from: embed.from,
    };
  }
  const removal = lineRemoval(doc, embed);
  const atEnd = before === doc.lines;
  const insertAt = atEnd ? doc.length : doc.line(before + 1).from;
  const changes = state.changes([
    removal,
    { from: insertAt, insert: atEnd ? `\n${text}` : `${text}\n` },
  ]);
  return {
    spec: { changes, userEvent: "move.embed" },
    from: changes.mapPos(insertAt, -1) + (atEnd ? 1 : 0),
  };
}

/** Sets the embed's width (CSS px), scaling a given height with it. */
export function resizeEmbed(embed: BlockEmbed, width: number): EmbedEdit | null {
  const next = Math.max(MIN_EMBED_WIDTH, Math.round(width));
  const { spec } = embed;
  const changes: Partial<EmbedSpec> = { width: next, widthPercent: undefined };
  if (spec.height !== undefined && spec.width !== undefined && spec.width > 0) {
    changes.height = Math.round((spec.height * next) / spec.width);
  }
  const text = formatEmbed(embed, changes);
  if (text === embed.text) return null;
  return {
    spec: { changes: { from: embed.from, to: embed.to, insert: text }, userEvent: "input.embed" },
    from: embed.from,
  };
}

/** Removes the embed's line. The embedded file stays, so undo brings the embed back. */
export function removeEmbed(state: EditorState, embed: BlockEmbed): TransactionSpec {
  return { changes: lineRemoval(state.doc, embed), userEvent: "delete.embed" };
}

/**
 * Inserts `text` (an `![[…]]`) on a line of its own at the main selection's line: on that line
 * when it's blank (with a new line after it for the caret), else above it. The caret stays off
 * the embed's line, so the live preview shows the embed rather than its syntax.
 */
export function insertEmbed(state: EditorState, text: string): EmbedEdit {
  const line = state.doc.lineAt(state.selection.main.head);
  if (line.text.trim() === "") {
    return {
      spec: {
        changes: { from: line.from, to: line.to, insert: `${text}\n` },
        selection: { anchor: line.from + text.length + 1 },
        userEvent: "input.embed",
      },
      from: line.from,
    };
  }
  const changes = state.changes({ from: line.from, insert: `${text}\n` });
  return {
    spec: { changes, selection: state.selection.map(changes, 1), userEvent: "input.embed" },
    from: line.from,
  };
}
