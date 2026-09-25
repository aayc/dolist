/**
 * Drawings rendered as images for models that can see them. The execution provider owns the
 * renderer (it needs a browser); where there is none, agents get the description alone.
 */
import type { DrawingScene } from "@ddl/core";

/** Longest side of a rendered drawing, like screenshots. */
export const DRAWING_IMAGE_MAX_SIZE = 1_280;

export interface RenderDrawingOptions {
  /** Longest side in pixels (default `DRAWING_IMAGE_MAX_SIZE`); small drawings are scaled up to 2×. */
  maxSize?: number;
  signal?: AbortSignal;
}

export interface RenderedDrawing {
  /** Base64 PNG. */
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
  /** Came from the render cache. */
  cached: boolean;
}

export interface DrawingRenderer {
  /** A PNG of the scene on a light background. Throws `DrawingRenderError`. */
  render(scene: DrawingScene, options?: RenderDrawingOptions): Promise<RenderedDrawing>;
  dispose(): Promise<void>;
}

export class DrawingRenderError extends Error {
  override name = "DrawingRenderError";
}
