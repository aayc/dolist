import type * as ExcalidrawModule from "./excalidraw-module";

export type ExcalidrawLib = typeof ExcalidrawModule;

declare global {
  interface Window {
    /** Where Excalidraw loads its fonts from (read when it registers them). */
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

let loading: Promise<ExcalidrawLib> | null = null;

/** The URL of the fonts our build serves (`excalidraw-assets.ts`), never a CDN. */
export function excalidrawAssetPath(): string {
  return new URL(`${import.meta.env.BASE_URL}${__EXCALIDRAW_ASSET_DIR__}`, window.location.href)
    .href;
}

/**
 * Excalidraw is a chunk of its own (~350 kB gzip), loaded the first time something shows a
 * drawing. A failed load is retried on the next call.
 */
export function loadExcalidraw(): Promise<ExcalidrawLib> {
  if (!loading) {
    window.EXCALIDRAW_ASSET_PATH = excalidrawAssetPath();
    loading = import("./excalidraw-module").catch((error: unknown) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}
