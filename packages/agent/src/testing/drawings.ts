/**
 * Synthetic drawings for tests and evals: labeled boxes in a row, arrows bound between them, free
 * text. `flowchartDrawing` returns the `.excalidraw.md` file the app writes.
 */
import {
  type DrawingElement,
  type DrawingScene,
  emptyDrawingScene,
  serializeDrawingFile,
} from "@ddl/core";

export interface FlowchartSpec {
  boxes: readonly string[];
  /** `[from, to, label?]` by box label. */
  arrows?: ReadonlyArray<readonly [string, string, string?]>;
  /** Free text elements. */
  notes?: readonly string[];
}

const BOX_WIDTH = 180;
const BOX_HEIGHT = 80;
const GAP = 80;

export function flowchartScene(spec: FlowchartSpec): DrawingScene {
  const elements: DrawingElement[] = [];
  const ids = new Map<string, string>();
  spec.boxes.forEach((label, i) => {
    const id = `box${i}`;
    ids.set(label, id);
    elements.push({
      id,
      type: "rectangle",
      x: i * (BOX_WIDTH + GAP),
      y: 0,
      width: BOX_WIDTH,
      height: BOX_HEIGHT,
      seed: 1_000 + i,
      boundElements: [{ id: `label${i}`, type: "text" }],
    });
    elements.push({
      id: `label${i}`,
      type: "text",
      x: i * (BOX_WIDTH + GAP) + 20,
      y: 30,
      width: BOX_WIDTH - 40,
      height: 20,
      text: label,
      originalText: label,
      containerId: id,
      fontSize: 20,
    });
  });
  (spec.arrows ?? []).forEach(([from, to, label], i) => {
    const start = spec.boxes.indexOf(from);
    const end = spec.boxes.indexOf(to);
    if (start < 0 || end < 0) throw new Error(`Unknown box in arrow ${from} → ${to}`);
    const x = start * (BOX_WIDTH + GAP) + BOX_WIDTH;
    const dx = (end - start) * (BOX_WIDTH + GAP) - BOX_WIDTH;
    const id = `arrow${i}`;
    elements.push({
      id,
      type: "arrow",
      x,
      y: BOX_HEIGHT / 2,
      width: Math.abs(dx),
      height: 0,
      points: [
        [0, 0],
        [dx, 0],
      ],
      startBinding: { elementId: ids.get(from)!, focus: 0, gap: 4 },
      endBinding: { elementId: ids.get(to)!, focus: 0, gap: 4 },
      endArrowhead: "arrow",
      seed: 2_000 + i,
      ...(label ? { boundElements: [{ id: `${id}-label`, type: "text" }] } : {}),
    });
    if (label) {
      elements.push({
        id: `${id}-label`,
        type: "text",
        x: x + dx / 2 - 20,
        y: BOX_HEIGHT / 2 - 10,
        width: 40,
        height: 20,
        text: label,
        originalText: label,
        containerId: id,
        fontSize: 16,
      });
    }
  });
  (spec.notes ?? []).forEach((text, i) => {
    elements.push({
      id: `note${i}`,
      type: "text",
      x: 0,
      y: BOX_HEIGHT + 60 + i * 30,
      width: 200,
      height: 20,
      text,
      originalText: text,
      fontSize: 16,
    });
  });
  return { ...emptyDrawingScene(), elements };
}

export function flowchartDrawing(spec: FlowchartSpec): string {
  return serializeDrawingFile(flowchartScene(spec));
}
