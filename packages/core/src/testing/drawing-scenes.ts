/**
 * Builds synthetic Excalidraw scenes for tests, fixtures and benchmarks: complete elements with
 * Excalidraw 0.18's fields in its key order, deterministic seeds, bindings kept in sync both ways.
 */
import {
  DRAWING_SCENE_SOURCE,
  type DrawingElement,
  type DrawingLinearElement,
  type DrawingPoint,
  type DrawingScene,
} from "../drawings/types";

type Extra = Record<string, unknown>;

interface LinearOptions {
  /** Bound to this element at the start (`startBinding`) or end. */
  start?: string;
  end?: string;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  extra?: Extra;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** FNV-1a: a stable 31-bit number per string, standing in for Excalidraw's random seeds. */
export function stableSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 2_147_483_647;
}

export class SceneBuilder {
  readonly elements: DrawingElement[] = [];
  private readonly files: Record<string, Record<string, unknown>> = {};

  private add<T extends DrawingElement>(type: string, id: string, box: Box, extra: Extra): T {
    const element = {
      id,
      type,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
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
      index: `a${this.elements.length.toString(36)}`,
      roundness: type === "rectangle" || type === "diamond" ? { type: 3 } : null,
      seed: stableSeed(id),
      version: 1,
      versionNonce: stableSeed(`${id}:nonce`),
      isDeleted: false,
      boundElements: null,
      updated: 1_790_000_000_000,
      link: null,
      locked: false,
      ...extra,
    } as unknown as T;
    this.elements.push(element);
    return element;
  }

  get(id: string): DrawingElement {
    const element = this.elements.find((e) => e.id === id);
    if (!element) throw new Error(`No element ${id}`);
    return element;
  }

  shape(
    type: "rectangle" | "ellipse" | "diamond",
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    extra: Extra = {},
  ): this {
    this.add(type, id, { x, y, width, height }, extra);
    return this;
  }

  rect(id: string, x: number, y: number, width = 160, height = 80, extra: Extra = {}): this {
    return this.shape("rectangle", id, x, y, width, height, extra);
  }

  /** A free-standing text element. */
  text(id: string, x: number, y: number, text: string, extra: Extra = {}): this {
    const lines = text.split("\n");
    const width = Math.round(Math.max(...lines.map((line) => line.length)) * 11);
    this.add("text", id, { x, y, width, height: lines.length * 25 }, textFields(text, null, extra));
    return this;
  }

  /** A label bound to a shape or an arrow (`containerId`, and the container's `boundElements`). */
  label(containerId: string, id: string, text: string, extra: Extra = {}): this {
    const container = this.get(containerId);
    const width = Math.round(Math.max(...text.split("\n").map((line) => line.length)) * 11);
    const height = text.split("\n").length * 25;
    const box = {
      x: (container.x ?? 0) + ((container.width ?? 0) - width) / 2,
      y: (container.y ?? 0) + ((container.height ?? 0) - height) / 2,
      width,
      height,
    };
    this.add("text", id, box, {
      ...textFields(text, containerId, { textAlign: "center", verticalAlign: "middle" }),
      ...extra,
    });
    bind(container, id, "text");
    return this;
  }

  linear(
    type: "arrow" | "line",
    id: string,
    points: DrawingPoint[],
    options: LinearOptions = {},
  ): this {
    const [x0, y0] = points[0]!;
    const relative = points.map(([x, y]) => [x - x0, y - y0] as DrawingPoint);
    const xs = relative.map(([x]) => x);
    const ys = relative.map(([, y]) => y);
    const box = {
      x: x0,
      y: y0,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
    const element = this.add<DrawingLinearElement>(type, id, box, {
      roundness: { type: 2 },
      points: relative,
      lastCommittedPoint: null,
      startBinding: options.start ? { elementId: options.start, focus: 0, gap: 5 } : null,
      endBinding: options.end ? { elementId: options.end, focus: 0, gap: 5 } : null,
      startArrowhead: options.startArrowhead ?? null,
      endArrowhead:
        options.endArrowhead === undefined
          ? type === "arrow"
            ? "arrow"
            : null
          : options.endArrowhead,
      ...(type === "arrow" ? { elbowed: false } : { polygon: false }),
      ...options.extra,
    });
    if (options.start) bind(this.get(options.start), element.id, "arrow");
    if (options.end) bind(this.get(options.end), element.id, "arrow");
    return this;
  }

  arrow(id: string, from: DrawingPoint, to: DrawingPoint, options: LinearOptions = {}): this {
    return this.linear("arrow", id, [from, to], options);
  }

  line(id: string, points: DrawingPoint[], extra: Extra = {}): this {
    return this.linear("line", id, points, { extra });
  }

  freedraw(id: string, x: number, y: number, points: DrawingPoint[], extra: Extra = {}): this {
    const xs = points.map(([px]) => px);
    const ys = points.map(([, py]) => py);
    const box = {
      x,
      y,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
    this.add("freedraw", id, box, {
      points,
      pressures: [],
      simulatePressure: true,
      lastCommittedPoint: null,
      ...extra,
    });
    return this;
  }

  /** A scribble of `count` points around (x, y), deterministic from the id. */
  scribble(id: string, x: number, y: number, size = 60, count = 12): this {
    const seed = stableSeed(id);
    const points: DrawingPoint[] = [];
    for (let i = 0; i < count; i++) {
      const t = (i / count) * Math.PI * 2;
      const wobble = ((seed >> (i % 16)) & 7) - 3;
      points.push([
        Math.round(Math.cos(t) * (size / 2) + size / 2 + wobble),
        Math.round(Math.sin(t) * (size / 2) + size / 2 - wobble),
      ]);
    }
    return this.freedraw(id, x, y, points);
  }

  /** A frame around existing elements (sets their `frameId`). */
  frame(
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    name: string | null,
    children: string[],
  ): this {
    this.add("frame", id, { x, y, width, height }, { name });
    for (const child of children) this.get(child).frameId = id;
    return this;
  }

  image(id: string, x: number, y: number, width: number, height: number, fileId: string): this {
    this.add(
      "image",
      id,
      { x, y, width, height },
      {
        fileId,
        status: "saved",
        scale: [1, 1],
        crop: null,
      },
    );
    this.files[fileId] = {
      mimeType: "image/png",
      id: fileId,
      // A 1×1 transparent PNG.
      dataURL:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      created: 1_790_000_000_000,
      lastRetrieved: 1_790_000_000_000,
    };
    return this;
  }

  /** Any element, for types we don't model. */
  other(type: string, id: string, x: number, y: number, extra: Extra = {}): this {
    this.add(type, id, { x, y, width: 100, height: 100 }, extra);
    return this;
  }

  delete(id: string): this {
    this.get(id).isDeleted = true;
    return this;
  }

  build(extra: Extra = {}): DrawingScene {
    return {
      type: "excalidraw",
      version: 2,
      source: DRAWING_SCENE_SOURCE,
      elements: this.elements.map((element) => structuredClone(element)),
      appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
      files: structuredClone(this.files) as DrawingScene["files"],
      ...extra,
    };
  }
}

function textFields(text: string, containerId: string | null, extra: Extra): Extra {
  return {
    text,
    fontSize: 20,
    fontFamily: 5,
    textAlign: "left",
    verticalAlign: "top",
    containerId,
    originalText: text,
    autoResize: true,
    lineHeight: 1.25,
    ...extra,
  };
}

function bind(target: DrawingElement, id: string, type: "arrow" | "text"): void {
  target.boundElements = [...(target.boundElements ?? []), { id, type }];
}
