import type { AppSettings, ThemePreference } from "@ddl/core";
import type { EditorConfig } from "@ddl/editor";
import { readString, STORAGE_KEYS, writeString } from "../../lib/storage";

export type ResolvedTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";
let removeSystemListener: (() => void) | null = null;

/** The preference the inline boot script used (the user's latest choice on this device). */
export function storedThemePreference(): ThemePreference | null {
  const value = readString(STORAGE_KEYS.theme);
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Applies the theme to :root and remembers the preference for the flash-free boot script. */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(preference);
  writeString(STORAGE_KEYS.theme, preference);
  removeSystemListener?.();
  removeSystemListener = null;
  if (preference === "system" && typeof matchMedia === "function") {
    const query = matchMedia(DARK_QUERY);
    const onChange = () => {
      root.dataset.theme = query.matches ? "dark" : "light";
    };
    query.addEventListener("change", onChange);
    removeSystemListener = () => query.removeEventListener("change", onChange);
  }
}

export function editorConfigFrom(settings: AppSettings): Partial<EditorConfig> {
  const { editor } = settings;
  return {
    vimMode: editor.vimMode,
    livePreview: editor.livePreview,
    readableLineLength: editor.readableLineLength,
    spellcheck: editor.spellcheck,
    showLineNumbers: editor.showLineNumbers,
    fontSize: editor.fontSize,
    readOnly: false,
  };
}

export function applyEditorCssVars(settings: AppSettings): void {
  const style = document.documentElement.style;
  style.setProperty("--ddl-editor-font-size", `${settings.editor.fontSize}px`);
  document.documentElement.classList.toggle(
    "readable-line-length",
    settings.editor.readableLineLength,
  );
}
