/** What the Node side sends the render page (`window.ddlRenderDrawing`) and gets back. */

export interface RenderPageInput {
  elements: unknown[];
  files: Record<string, unknown>;
  /** Longest side of the image, in pixels. */
  maxSize: number;
  /** Small drawings are scaled up, at most this much. */
  maxScale: number;
  /** Around the drawing, in scene pixels (before scaling). */
  padding: number;
  /** CSS color behind the drawing. */
  background: string;
}

export interface RenderPageOutput {
  /** Base64 PNG. */
  data: string;
  width: number;
  height: number;
}
