/**
 * The render page's script. It runs in headless Chromium, never in Node (the daemon's build
 * bundles it with esbuild, see `scripts/build-drawing-renderer.mjs`), and exposes
 * `window.ddlRenderDrawing`: a scene to a PNG with Excalidraw's own export, so the agent sees a
 * drawing the way the editor draws it. `asset-path.js` (written by the build) runs first and
 * points Excalidraw's fonts at the page's own origin.
 */
import { exportToBlob } from "@excalidraw/excalidraw";
import type { RenderPageInput, RenderPageOutput } from "./protocol";

type ExportOptions = Parameters<typeof exportToBlob>[0];

/** Excalidraw's `FONT_FAMILY.Excalifont`, its editor's default for text. */
const EXCALIFONT = 5;

/**
 * Excalidraw loads the fonts an export needs by the text elements' `fontFamily`: one written
 * without it would be drawn in the browser's default font.
 */
function withFonts(elements: readonly unknown[]): unknown[] {
  return elements.map((element) => {
    const text = element as { type?: unknown; fontFamily?: unknown };
    return text.type === "text" && typeof text.fontFamily !== "number"
      ? { ...text, fontFamily: EXCALIFONT }
      : element;
  });
}

window.ddlRenderDrawing = async (input: RenderPageInput): Promise<RenderPageOutput> => {
  let size = { width: 0, height: 0 };
  const blob = await exportToBlob({
    elements: withFonts(input.elements) as ExportOptions["elements"],
    files: input.files as ExportOptions["files"],
    appState: {
      exportBackground: true,
      exportWithDarkMode: false,
      viewBackgroundColor: input.background,
    },
    exportPadding: input.padding,
    mimeType: "image/png",
    getDimensions: (width: number, height: number) => {
      const scale = Math.min(input.maxScale, input.maxSize / width, input.maxSize / height);
      size = {
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
      };
      return { ...size, scale };
    },
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { data: btoa(binary), ...size };
};
