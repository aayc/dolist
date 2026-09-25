/** Everything the app uses from Excalidraw, in the lazily loaded chunk (see `excalidraw-loader`). */
import "@excalidraw/excalidraw/index.css";
import type { DrawingElement, DrawingScene } from "@ddl/core";
import { exportToCanvas, exportToSvg, getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement, NonDeleted } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { RenderedDrawing } from "./render-cache";

export { CaptureUpdateAction } from "@excalidraw/excalidraw";
export { mountDrawingEditor } from "./DrawingEditor";

/** Around the drawing in its static render, in CSS pixels at 100%. */
export const RENDER_PADDING = 8;

type Live = NonDeleted<ExcalidrawElement>[];

function live(elements: readonly DrawingElement[]): Live {
  return elements.filter((element) => element.isDeleted !== true) as unknown as Live;
}

/** The drawing's bounding box in scene units: `[minX, minY, maxX, maxY]`, or null when empty. */
export function sceneBounds(
  elements: readonly DrawingElement[],
): readonly [number, number, number, number] | null {
  const shown = live(elements);
  return shown.length === 0 ? null : getCommonBounds(shown);
}

/**
 * A static SVG of the drawing, without a background (it sits on the note), in the light theme (the
 * dark theme inverts it with CSS, as Excalidraw's own dark mode does). Its text uses the fonts
 * Excalidraw registers in the document, which rendering to a tiny canvas first loads.
 */
export async function renderDrawing(scene: DrawingScene): Promise<RenderedDrawing> {
  const elements = live(scene.elements);
  if (elements.length === 0) return { svg: null, width: 0, height: 0 };
  const files = scene.files as unknown as BinaryFiles;
  const appState = {
    exportBackground: false,
    exportWithDarkMode: false,
    viewBackgroundColor: String(scene.appState.viewBackgroundColor ?? "#ffffff"),
  };
  const texts = elements.filter((element) => element.type === "text");
  if (texts.length > 0) {
    await exportToCanvas({
      elements: texts,
      appState,
      files: null,
      getDimensions: () => ({ width: 1, height: 1, scale: 1 }),
    });
  }
  const svg = await exportToSvg({
    elements,
    appState,
    files,
    exportPadding: RENDER_PADDING,
    skipInliningFonts: true,
  });
  const width = Number.parseFloat(svg.getAttribute("width") ?? "0");
  const height = Number.parseFloat(svg.getAttribute("height") ?? "0");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("drawing-svg");
  return { svg, width, height };
}
