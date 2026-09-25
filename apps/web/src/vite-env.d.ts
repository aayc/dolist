/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
/** Where Excalidraw's fonts are served, relative to the base URL (`excalidraw-assets.ts`). */
declare const __EXCALIDRAW_ASSET_DIR__: string;

interface ImportMetaEnv {
  /** "1" selects the in-browser mock daemon (same as `?mock=1`). */
  readonly VITE_DDL_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
