export interface DrawingRendererBuild {
  /** The `@excalidraw/excalidraw` version bundled. */
  excalidraw: string;
  /** Hash of the build; keys the render cache. */
  build: string;
}

export function buildDrawingRenderer(
  outDir: string,
  options?: { logLevel?: "silent" | "error" | "warning" | "info" },
): Promise<DrawingRendererBuild>;
