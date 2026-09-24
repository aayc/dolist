/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** "1" selects the in-browser mock daemon (same as `?mock=1`). */
  readonly VITE_DDL_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
