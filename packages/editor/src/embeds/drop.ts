import type { EmbedMove } from "./edits";

/** A line as drawn, in any vertical coordinate system shared with the point. */
export interface LineBox {
  /** 0-based. */
  index: number;
  top: number;
  bottom: number;
}

export interface DropGeometry {
  /** The line drawn at height `y` (the first or last line beyond the document's ends). */
  lineAt(y: number): LineBox;
  lineCount: number;
  /** The text column's horizontal extent, in the point's coordinates. */
  left: number;
  right: number;
}

export interface DropTarget extends EmbedMove {
  /** Where to draw the indicator: the boundary between two lines. */
  y: number;
}

/**
 * Where a dragged embed lands, given its box's top edge (`y`) and center (`x`): between the two
 * lines nearest that edge, floating left in the column's left third, right in its right third,
 * full width in between.
 */
export function dropTarget(point: { x: number; y: number }, geometry: DropGeometry): DropTarget {
  const line = geometry.lineAt(point.y);
  const upper = point.y < (line.top + line.bottom) / 2;
  const before = Math.min(Math.max(upper ? line.index : line.index + 1, 0), geometry.lineCount);
  const third = (geometry.right - geometry.left) / 3;
  const placement =
    point.x < geometry.left + third
      ? "left-wrap"
      : point.x > geometry.right - third
        ? "right-wrap"
        : "full";
  return { before, placement, y: upper ? line.top : line.bottom };
}
