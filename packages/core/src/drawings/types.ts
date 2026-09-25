/**
 * Excalidraw's scene schema (`@excalidraw/excalidraw` 0.18, `ExcalidrawElement` and friends), as
 * stored in the `## Drawing` block of an `.excalidraw.md` file. Only `id` and `type` are
 * guaranteed: files come from other apps and other versions, and Excalidraw fills in defaults when
 * it restores a scene. Every object keeps the fields we don't model, so they survive a round trip.
 */

export type DrawingFillStyle = "hachure" | "cross-hatch" | "solid" | "zigzag";
export type DrawingStrokeStyle = "solid" | "dashed" | "dotted";
export type DrawingTextAlign = "left" | "center" | "right";
export type DrawingVerticalAlign = "top" | "middle" | "bottom";
export type DrawingArrowhead =
  | "arrow"
  | "bar"
  | "dot"
  | "circle"
  | "circle_outline"
  | "triangle"
  | "triangle_outline"
  | "diamond"
  | "diamond_outline"
  | "crowfoot_one"
  | "crowfoot_many"
  | "crowfoot_one_or_many";

/** Excalidraw's `FONT_FAMILY` ids (4 is unused: it was Assistant, or the plugin's custom font). */
export const DRAWING_FONT_FAMILIES = {
  Virgil: 1,
  Helvetica: 2,
  Cascadia: 3,
  Excalifont: 5,
  Nunito: 6,
  "Lilita One": 7,
  "Comic Shanns": 8,
  "Liberation Sans": 9,
  Assistant: 10,
} as const;

/** Excalidraw's `ROUNDNESS` types for `roundness.type`. */
export const DRAWING_ROUNDNESS = {
  legacy: 1,
  proportionalRadius: 2,
  adaptiveRadius: 3,
} as const;

/** A point relative to the element's `x`/`y`. */
export type DrawingPoint = [number, number];

export interface DrawingPointBinding {
  elementId: string;
  focus?: number;
  gap?: number;
  /** Elbow arrows bind to a fixed point of the element, as ratios of its size. */
  fixedPoint?: DrawingPoint | null;
  [key: string]: unknown;
}

export interface DrawingBoundElement {
  id: string;
  type: "arrow" | "text";
  [key: string]: unknown;
}

/** Fields every Excalidraw element has (`_ExcalidrawElementBase`). */
export interface DrawingElement {
  id: string;
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: DrawingFillStyle;
  strokeWidth?: number;
  strokeStyle?: DrawingStrokeStyle;
  /** 0 architect, 1 artist, 2 cartoonist. */
  roughness?: number;
  /** 0–100. */
  opacity?: number;
  roundness?: { type: number; value?: number } | null;
  /** Seeds the hand-drawn (Rough.js) shape so it looks the same on every render. */
  seed?: number;
  version?: number;
  versionNonce?: number;
  /** Fractional index for ordering; null for elements not yet placed. */
  index?: string | null;
  isDeleted?: boolean;
  /** Deepest group first. */
  groupIds?: string[];
  frameId?: string | null;
  boundElements?: DrawingBoundElement[] | null;
  /** Epoch ms of the last change. */
  updated?: number;
  link?: string | null;
  locked?: boolean;
  customData?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DrawingShapeElement extends DrawingElement {
  type: "rectangle" | "ellipse" | "diamond";
}

export interface DrawingTextElement extends DrawingElement {
  type: "text";
  fontSize?: number;
  /** One of `DRAWING_FONT_FAMILIES`. */
  fontFamily?: number;
  /** As rendered: includes the line breaks Excalidraw adds to wrap text in a container. */
  text?: string;
  /** As typed, without wrapping. */
  originalText?: string;
  /** The Obsidian plugin's copy of the text with its markdown links unparsed. */
  rawText?: string;
  textAlign?: DrawingTextAlign;
  verticalAlign?: DrawingVerticalAlign;
  /** The shape or arrow this text is the label of. */
  containerId?: string | null;
  autoResize?: boolean;
  lineHeight?: number;
}

export interface DrawingLinearElement extends DrawingElement {
  type: "arrow" | "line";
  points?: DrawingPoint[];
  lastCommittedPoint?: DrawingPoint | null;
  startBinding?: DrawingPointBinding | null;
  endBinding?: DrawingPointBinding | null;
  startArrowhead?: DrawingArrowhead | null;
  endArrowhead?: DrawingArrowhead | null;
  /** Arrows only. */
  elbowed?: boolean;
  /** Lines only: closed into a polygon. */
  polygon?: boolean;
}

export interface DrawingFreedrawElement extends DrawingElement {
  type: "freedraw";
  points?: DrawingPoint[];
  pressures?: number[];
  simulatePressure?: boolean;
  lastCommittedPoint?: DrawingPoint | null;
}

export interface DrawingImageElement extends DrawingElement {
  type: "image";
  /** Key into the scene's `files`. */
  fileId?: string | null;
  status?: "pending" | "saved" | "error";
  scale?: DrawingPoint;
  crop?: {
    x: number;
    y: number;
    width: number;
    height: number;
    naturalWidth: number;
    naturalHeight: number;
  } | null;
}

export interface DrawingFrameElement extends DrawingElement {
  type: "frame" | "magicframe";
  name?: string | null;
}

/** The element types we model; anything else is a plain `DrawingElement`. */
export interface KnownDrawingElements {
  rectangle: DrawingShapeElement;
  ellipse: DrawingShapeElement;
  diamond: DrawingShapeElement;
  text: DrawingTextElement;
  arrow: DrawingLinearElement;
  line: DrawingLinearElement;
  freedraw: DrawingFreedrawElement;
  image: DrawingImageElement;
  frame: DrawingFrameElement;
  magicframe: DrawingFrameElement;
}

export type KnownDrawingElementType = keyof KnownDrawingElements;

export function isDrawingElementOfType<T extends KnownDrawingElementType>(
  element: DrawingElement,
  type: T,
): element is KnownDrawingElements[T] {
  return element.type === type;
}

/** The part of Excalidraw's `AppState` a drawing file stores; the plugin stores more. */
export interface DrawingAppState {
  viewBackgroundColor?: string;
  theme?: "light" | "dark";
  gridSize?: number | null;
  gridStep?: number;
  gridModeEnabled?: boolean;
  [key: string]: unknown;
}

/** An image in the scene's `files` (Excalidraw's `BinaryFileData`). */
export interface DrawingBinaryFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created?: number;
  lastRetrieved?: number;
  version?: number;
  [key: string]: unknown;
}

export type DrawingBinaryFiles = Record<string, DrawingBinaryFile>;

/** Excalidraw's exported scene (`ExportedDataState`). */
export interface DrawingScene {
  /** `"excalidraw"`. */
  type: string;
  /** `2`. */
  version: number;
  source?: string;
  elements: DrawingElement[];
  appState: DrawingAppState;
  files: DrawingBinaryFiles;
  [key: string]: unknown;
}

/** Where the Obsidian plugin's scene `source` points, followed by `<plugin version>`. */
export const DRAWING_PLUGIN_SOURCE_PREFIX =
  "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/tag/";

/**
 * The `source` we write. The plugin reads its own version from `source` and treats any other value
 * as a pre-1.8.16 drawing, flagging every text container `legacyTextWrap` (which changes how text
 * wraps in ellipses and diamonds). So we name the plugin version whose format we follow.
 */
export const DRAWING_SCENE_SOURCE = `${DRAWING_PLUGIN_SOURCE_PREFIX}2.27.3`;

/** A new, empty scene, as the plugin creates one. */
export function emptyDrawingScene(): DrawingScene {
  return {
    type: "excalidraw",
    version: 2,
    source: DRAWING_SCENE_SOURCE,
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}
