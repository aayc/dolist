import type { Extension } from "@codemirror/state";
import { editorCallbacks } from "./callbacks";

type VimModule = typeof import("@replit/codemirror-vim");

/**
 * Vim is ~300 KB of source, so it is loaded on demand: `vimMode(true)` yields nothing until the
 * module arrives, then editors that asked for it reconfigure (see `onVimLoaded`).
 */
let vimModule: VimModule | null = null;
let loading: Promise<VimModule> | null = null;
const loadedListeners = new Set<() => void>();

function registerExCommands(module: VimModule): void {
  // Vim's ex commands are global; `:w` resolves the editor's callbacks from the calling view.
  module.Vim.defineEx("write", "w", (cm) => {
    cm.cm6.state.facet(editorCallbacks).onSave?.();
  });
}

/** Starts loading vim (idempotent). Hosts call this early when the user has vim mode on. */
export function preloadVim(): Promise<void> {
  loading ??= import("@replit/codemirror-vim").then((module) => {
    registerExCommands(module);
    vimModule = module;
    for (const listener of [...loadedListeners]) listener();
    loadedListeners.clear();
    return module;
  });
  return loading.then(() => undefined);
}

export function isVimLoaded(): boolean {
  return vimModule !== null;
}

/** Calls `listener` once vim has loaded (immediately-resolved loads still notify asynchronously). */
export function onVimLoaded(listener: () => void): () => void {
  loadedListeners.add(listener);
  return () => loadedListeners.delete(listener);
}

/** Vim keybindings. Must be the first extension so its key handling runs before any keymap. */
export function vimMode(enabled: boolean): Extension {
  if (!enabled) return [];
  if (!vimModule) {
    void preloadVim();
    return [];
  }
  return vimModule.vim();
}
