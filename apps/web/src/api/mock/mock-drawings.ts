import {
  type DrawingBoundElement,
  type DrawingElement,
  emptyDrawingScene,
  serializeDrawingFile,
} from "@ddl/core";

/** The demo vault's drawing, embedded in `Sketches.md`. Synthetic content. */
export const DEMO_DRAWING_PATH = "Excalidraw/Garden plan.excalidraw.md";

function base(id: string, type: string, x: number, y: number, width: number, height: number) {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: id.charCodeAt(0) * 1009 + id.charCodeAt(1),
    version: 1,
    versionNonce: id.charCodeAt(2) * 7919,
    isDeleted: false,
    boundElements: null,
    updated: 1_758_800_000_000,
    link: null,
    locked: false,
  } satisfies DrawingElement;
}

function label(id: string, containerId: string, text: string, x: number, y: number, width: number) {
  return {
    ...base(id, "text", x, y, width, 25),
    text,
    originalText: text,
    fontSize: 20,
    fontFamily: 5,
    textAlign: "center",
    verticalAlign: "middle",
    containerId,
    autoResize: true,
    lineHeight: 1.25,
  } satisfies DrawingElement;
}

/** Two beds joined by a path to a pond: shapes with labels and a bound arrow. */
export function demoDrawing(): string {
  const bound = (text: string): DrawingBoundElement[] => [
    { id: text, type: "text" },
    { id: "pathArw1", type: "arrow" },
  ];
  const beds = {
    ...base("bedsA1b2", "rectangle", 0, 0, 180, 90),
    backgroundColor: "#b2f2bb",
    boundElements: bound("bedsTxt1"),
  };
  const pond = {
    ...base("pondC3d4", "ellipse", 60, 190, 170, 90),
    backgroundColor: "#a5d8ff",
    boundElements: bound("pondTxt1"),
  };
  const path = {
    ...base("pathArw1", "arrow", 100, 96, 40, 88),
    points: [
      [0, 0],
      [40, 88],
    ],
    startBinding: { elementId: "bedsA1b2", focus: 0, gap: 6 },
    endBinding: { elementId: "pondC3d4", focus: 0, gap: 6 },
    startArrowhead: null,
    endArrowhead: "arrow",
    roundness: { type: 2 },
  };
  const elements: DrawingElement[] = [
    beds,
    label("bedsTxt1", "bedsA1b2", "Raised beds", 5, 32, 170),
    pond,
    label("pondTxt1", "pondC3d4", "Pond", 95, 222, 100),
    path,
  ];
  return serializeDrawingFile({ ...emptyDrawingScene(), elements });
}

export const SKETCHES_NOTE = [
  "# Sketches",
  "",
  "![[Garden plan.excalidraw|300|right-wrap]]",
  "The garden plan is a drawing: double-click it to draw, drag it to move it, or pull its corner",
  "to resize it. The text wraps around it, and it's a plain Excalidraw file that Obsidian opens too.",
  "",
  "- [ ] Measure the south fence",
  "- [ ] Pick plants for the pond edge",
].join("\n");
