import type { DrawingScene } from "@ddl/core";
import { LruMap } from "../../lib/lru";

export type DrawingTheme = "light" | "dark";

/** A static render: an SVG to clone into each embed, or null for an empty drawing. */
export interface RenderedDrawing {
  svg: SVGSVGElement | null;
  /** CSS pixels at 100%, padding included. */
  width: number;
  height: number;
}

export type RenderDrawing = (scene: DrawingScene, theme: DrawingTheme) => Promise<RenderedDrawing>;

interface Entry {
  promise: Promise<RenderedDrawing>;
  value: RenderedDrawing | null;
}

/**
 * Static renders by content hash and theme: a drawing renders once per version, however many
 * embeds show it and however often they scroll into view.
 */
export class DrawingRenders {
  private readonly render: RenderDrawing;
  private readonly cache: LruMap<string, Entry>;

  constructor(render: RenderDrawing, capacity = 64) {
    this.render = render;
    this.cache = new LruMap(capacity);
  }

  /** The render, if it's ready (so an embed scrolling back into view paints at once). */
  peek(hash: string, theme: DrawingTheme): RenderedDrawing | null {
    return this.cache.get(`${hash}:${theme}`)?.value ?? null;
  }

  get(hash: string, scene: DrawingScene, theme: DrawingTheme): Promise<RenderedDrawing> {
    const key = `${hash}:${theme}`;
    const cached = this.cache.get(key);
    if (cached) return cached.promise;
    const promise = this.render(scene, theme).then(
      (value) => {
        entry.value = value;
        return value;
      },
      (error: unknown) => {
        if (this.cache.peek(key) === entry) this.cache.delete(key);
        throw error;
      },
    );
    const entry: Entry = { promise, value: null };
    this.cache.set(key, entry);
    return promise;
  }
}
