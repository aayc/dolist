/**
 * A compact text description of a drawing, for the agent (and for clients that show one): its
 * title and size, text, shapes with their labels, what the arrows connect, lines, freehand strokes
 * and where they are, frames and what they hold. Deterministic: the same scene always gives the
 * same text, so it can be cached and compared. The Swift port must produce the same bytes (see
 * `packages/core/test/drawings/README.md`); lengths are counted in Unicode code points.
 *
 *     Drawing “System” (620×300 px, 9 elements)
 *     Text: “Draft”
 *     Shapes: rectangle “API”, rectangle “DB”, 1 unlabeled ellipse
 *     Arrows: “API” → “DB” labeled “SQL”, arrow from “DB” to near an ellipse
 *     Freehand: 2 freehand strokes, bottom left
 *     Frames: frame “Backend” with rectangle “API”, rectangle “DB”, 1 arrow
 */
import type { DrawingElement, DrawingScene } from "./types";

export interface DescribeDrawingOptions {
  /** The drawing's name, usually its file name (`drawingTitleFromPath`). */
  title: string;
  /** Longest description, in code points. Default `DRAWING_DESCRIPTION_MAX_LENGTH`. */
  maxLength?: number;
}

export const DRAWING_DESCRIPTION_MAX_LENGTH = 2000;

const TITLE_CHARS = 100;
const LABEL_CHARS = 60;
/** An unbound arrow end this close to an element (in scene pixels) is "near" it. */
const NEAR_DISTANCE = 50;
const TRUNCATION_NOTE = "(Shortened: not every item is listed.)";
/** JavaScript's `\s`, spelled out so other implementations match it exactly. */
const WHITESPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g;

const SHAPES = ["rectangle", "ellipse", "diamond"] as const;
const FRAMES = new Set(["frame", "magicframe"]);
const NEAR_CANDIDATES = new Set(["rectangle", "ellipse", "diamond", "text", "image"]);
const LOCATIONS = [
  "top left",
  "top",
  "top right",
  "left",
  "center",
  "right",
  "bottom left",
  "bottom",
  "bottom right",
];

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Section {
  label: string;
  items: string[];
  separator: string;
}

interface Endpoint {
  bound: boolean;
  name: string;
}

export function describeDrawing(scene: DrawingScene, options: DescribeDrawingOptions): string {
  const maxLength = options.maxLength ?? DRAWING_DESCRIPTION_MAX_LENGTH;
  const title = `Drawing “${clip(normalize(options.title), TITLE_CHARS)}”`;
  const elements = scene.elements.filter((element) => element.isDeleted !== true);
  if (elements.length === 0) return fit([`${title} (empty)`], [], maxLength);

  const context = new DescribeContext(elements);
  const bounds = union(elements.map(boxOf));
  const width = Math.round(bounds.maxX - bounds.minX);
  const height = Math.round(bounds.maxY - bounds.minY);
  const header = `${title} (${width}×${height} px, ${count(elements.length, "element")})`;

  const sections: Section[] = [
    { label: "Text", items: context.freeTexts.map((text) => quote(text)), separator: ", " },
    { label: "Shapes", items: context.shapeItems(elements), separator: ", " },
    {
      label: "Arrows",
      items: elements.filter((e) => e.type === "arrow").map((e) => context.arrowItem(e)),
      separator: ", ",
    },
    {
      label: "Lines",
      items: counted(elements, "line", "line", bounds),
      separator: ", ",
    },
    {
      label: "Freehand",
      items: counted(elements, "freedraw", "freehand stroke", bounds),
      separator: ", ",
    },
    {
      label: "Frames",
      items: elements.filter((e) => FRAMES.has(e.type)).map((e) => context.frameItem(e)),
      separator: "; ",
    },
    {
      label: "Images",
      items: nonZero(elements.filter((e) => e.type === "image").length, "image"),
      separator: ", ",
    },
    { label: "Other", items: context.otherItems(elements), separator: ", " },
  ];
  return fit([header], sections, maxLength);
}

class DescribeContext {
  private readonly byId = new Map<string, DrawingElement>();
  /** Labels of shapes and arrows, from the text elements bound to them. */
  private readonly labels = new Map<string, string>();
  private readonly boundTexts = new Set<string>();
  readonly freeTexts: string[] = [];
  private readonly candidates: Array<{ element: DrawingElement; box: Box }> = [];

  constructor(elements: readonly DrawingElement[]) {
    for (const element of elements) this.byId.set(element.id, element);
    const bound = new Map<string, string[]>();
    for (const element of elements) {
      if (element.type !== "text") continue;
      const container = typeof element.containerId === "string" ? element.containerId : null;
      if (container !== null && container !== element.id && this.byId.has(container)) {
        this.boundTexts.add(element.id);
        bound.set(container, [...(bound.get(container) ?? []), textOf(element)]);
      }
    }
    for (const [id, texts] of bound) {
      const label = texts.filter((text) => text !== "").join(" / ");
      if (label !== "") this.labels.set(id, clip(label, LABEL_CHARS));
    }
    for (const element of elements) {
      if (element.type === "text" && !this.boundTexts.has(element.id)) {
        const text = clip(textOf(element), LABEL_CHARS);
        if (text !== "") this.freeTexts.push(text);
      }
      if (NEAR_CANDIDATES.has(element.type) && !this.boundTexts.has(element.id)) {
        this.candidates.push({ element, box: boxOf(element) });
      }
    }
  }

  shapeItems(elements: readonly DrawingElement[]): string[] {
    const items: string[] = [];
    const unlabeled = new Map<string, number>();
    for (const element of elements) {
      if (!(SHAPES as readonly string[]).includes(element.type)) continue;
      const label = this.labels.get(element.id);
      if (label !== undefined) items.push(`${element.type} ${quote(label)}`);
      else unlabeled.set(element.type, (unlabeled.get(element.type) ?? 0) + 1);
    }
    for (const type of SHAPES) {
      const n = unlabeled.get(type) ?? 0;
      if (n > 0) items.push(`${n} unlabeled ${plural(type, n)}`);
    }
    return items;
  }

  arrowItem(arrow: DrawingElement): string {
    let from = this.endpoint(arrow, "start");
    let to = this.endpoint(arrow, "end");
    const startHead = typeof arrow.startArrowhead === "string";
    const endHead = arrow.endArrowhead === undefined || typeof arrow.endArrowhead === "string";
    if (startHead && !endHead) [from, to] = [to, from];
    const symbol = startHead && endHead ? "↔" : !startHead && !endHead ? "—" : "→";
    let item: string;
    if (from?.bound && to?.bound) {
      item = `${from.name} ${symbol} ${to.name}`;
    } else {
      item = "arrow";
      if (from) item += ` from ${from.bound ? "" : "near "}${from.name}`;
      if (to) item += ` to ${to.bound ? "" : "near "}${to.name}`;
    }
    const label = this.labels.get(arrow.id);
    return label === undefined ? item : `${item} labeled ${quote(label)}`;
  }

  frameItem(frame: DrawingElement): string {
    const name =
      typeof frame.name === "string" && normalize(frame.name) !== ""
        ? `frame ${quote(clip(normalize(frame.name), LABEL_CHARS))}`
        : "frame";
    const children = [...this.byId.values()].filter(
      (element) => element.frameId === frame.id && !this.boundTexts.has(element.id),
    );
    if (children.length === 0) return `${name} (empty)`;
    const items: string[] = [];
    const counts = new Map<string, number>();
    for (const child of children) {
      const label = this.labels.get(child.id);
      if ((SHAPES as readonly string[]).includes(child.type) && label !== undefined) {
        items.push(`${child.type} ${quote(label)}`);
      } else if (child.type === "text" && textOf(child) !== "") {
        items.push(quote(clip(textOf(child), LABEL_CHARS)));
      } else {
        const kind = (SHAPES as readonly string[]).includes(child.type)
          ? `unlabeled ${child.type}`
          : child.type === "freedraw"
            ? "freehand stroke"
            : child.type;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }
    for (const [kind, n] of counts) items.push(count(n, kind));
    return `${name} with ${items.join(", ")}`;
  }

  otherItems(elements: readonly DrawingElement[]): string[] {
    const known = new Set<string>([
      ...SHAPES,
      "text",
      "arrow",
      "line",
      "freedraw",
      "image",
      ...FRAMES,
    ]);
    const counts = new Map<string, number>();
    for (const element of elements) {
      if (!known.has(element.type)) counts.set(element.type, (counts.get(element.type) ?? 0) + 1);
    }
    return [...counts].map(([type, n]) => count(n, type));
  }

  private endpoint(arrow: DrawingElement, end: "start" | "end"): Endpoint | null {
    const binding = end === "start" ? arrow.startBinding : arrow.endBinding;
    const boundId =
      typeof binding === "object" && binding !== null && "elementId" in binding
        ? binding.elementId
        : undefined;
    const target = typeof boundId === "string" ? this.byId.get(boundId) : undefined;
    if (target && target.id !== arrow.id) return { bound: true, name: this.nameOf(target) };

    const point = endPoint(arrow, end);
    if (!point) return null;
    let best: { element: DrawingElement; distance: number; area: number } | null = null;
    for (const { element, box } of this.candidates) {
      const dx = Math.max(box.minX - point[0], 0, point[0] - box.maxX);
      const dy = Math.max(box.minY - point[1], 0, point[1] - box.maxY);
      const distance = Math.hypot(dx, dy);
      if (distance > NEAR_DISTANCE) continue;
      const area = (box.maxX - box.minX) * (box.maxY - box.minY);
      if (!best || distance < best.distance || (distance === best.distance && area < best.area)) {
        best = { element, distance, area };
      }
    }
    return best ? { bound: false, name: this.nameOf(best.element) } : null;
  }

  private nameOf(element: DrawingElement): string {
    const label = this.labels.get(element.id);
    if (label !== undefined) return quote(label);
    if (element.type === "text") {
      const text = clip(textOf(element), LABEL_CHARS);
      return text === "" ? "a text" : quote(text);
    }
    if (FRAMES.has(element.type)) {
      return typeof element.name === "string" && normalize(element.name) !== ""
        ? `frame ${quote(clip(normalize(element.name), LABEL_CHARS))}`
        : "a frame";
    }
    return `${/^[aeiou]/.test(element.type) ? "an" : "a"} ${element.type}`;
  }
}

/** `n` elements of `type` as "3 freehand strokes, top left" or "5 lines: 3 top, 2 bottom". */
function counted(
  elements: readonly DrawingElement[],
  type: string,
  noun: string,
  bounds: Box,
): string[] {
  const matching = elements.filter((element) => element.type === type);
  if (matching.length === 0) return [];
  const perCell = new Array<number>(LOCATIONS.length).fill(0);
  for (const element of matching) {
    const box = boxOf(element);
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    perCell[cell(cx, bounds.minX, bounds.maxX) + 3 * cell(cy, bounds.minY, bounds.maxY)]!++;
  }
  const places = LOCATIONS.flatMap((location, i) =>
    perCell[i]! > 0 ? [[location, perCell[i]!] as const] : [],
  );
  const total = count(matching.length, noun);
  if (places.length === 1) return [`${total}, ${places[0]![0]}`];
  return [`${total}: ${places.map(([location, n]) => `${n} ${location}`).join(", ")}`];
}

/** 0, 1 or 2: which third of [min, max] `value` is in. */
function cell(value: number, min: number, max: number): number {
  const relative = max > min ? (value - min) / (max - min) : 0.5;
  return relative < 1 / 3 ? 0 : relative > 2 / 3 ? 2 : 1;
}

/**
 * The header and sections, shortened to `maxLength`: each section lists at most as many items as
 * fit (the rest become "… and N more"), then a note says so. Beyond that the text is cut.
 */
function fit(head: string[], sections: readonly Section[], maxLength: number): string {
  const render = (cap: number) =>
    [
      ...head,
      ...sections
        .filter((section) => section.items.length > 0)
        .map((section) => {
          const shown = section.items.slice(0, cap);
          const rest = section.items.length - shown.length;
          if (rest > 0) shown.push(`… and ${rest} more`);
          return `${section.label}: ${shown.join(section.separator)}`;
        }),
    ].join("\n");
  const most = Math.max(0, ...sections.map((section) => section.items.length));
  const full = render(most);
  if (length(full) <= maxLength) return full;

  const budget = maxLength - length(TRUNCATION_NOTE) - 1;
  let low = 0;
  let high = most - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (length(render(mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  const shortened = render(low);
  if (length(shortened) <= budget) return `${shortened}\n${TRUNCATION_NOTE}`;
  const cut = Array.from(shortened)
    .slice(0, Math.max(0, budget - 1))
    .join("");
  return `${cut}…\n${TRUNCATION_NOTE}`;
}

function textOf(element: DrawingElement): string {
  const text =
    typeof element.originalText === "string" && element.originalText !== ""
      ? element.originalText
      : typeof element.text === "string"
        ? element.text
        : "";
  return normalize(text);
}

function normalize(text: string): string {
  return text.replace(WHITESPACE, " ").replace(/^ | $/g, "");
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

function quote(text: string): string {
  return `“${text}”`;
}

function length(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

function count(n: number, noun: string): string {
  return `${n} ${plural(noun, n)}`;
}

function nonZero(n: number, noun: string): string[] {
  return n > 0 ? [count(n, noun)] : [];
}

function plural(noun: string, n: number): string {
  return n === 1 ? noun : `${noun}s`;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pointsOf(element: DrawingElement): Array<[number, number]> {
  const points = element.points;
  if (!Array.isArray(points)) return [];
  const out: Array<[number, number]> = [];
  for (const point of points) {
    if (Array.isArray(point)) out.push([finite(point[0]), finite(point[1])]);
  }
  return out;
}

/** The element's unrotated bounding box; linear elements and strokes by their points. */
function boxOf(element: DrawingElement): Box {
  const x = finite(element.x);
  const y = finite(element.y);
  const points = pointsOf(element);
  if (points.length > 0) {
    return union(
      points.map(([px, py]) => ({ minX: x + px, minY: y + py, maxX: x + px, maxY: y + py })),
    );
  }
  const width = finite(element.width);
  const height = finite(element.height);
  return {
    minX: Math.min(x, x + width),
    minY: Math.min(y, y + height),
    maxX: Math.max(x, x + width),
    maxY: Math.max(y, y + height),
  };
}

function endPoint(element: DrawingElement, end: "start" | "end"): [number, number] | null {
  const points = pointsOf(element);
  const point = end === "start" ? points[0] : points[points.length - 1];
  return point ? [finite(element.x) + point[0], finite(element.y) + point[1]] : null;
}

function union(boxes: readonly Box[]): Box {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
  }
  return { minX, minY, maxX, maxY };
}
