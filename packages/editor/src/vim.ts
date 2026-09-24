import { type Extension, Facet } from "@codemirror/state";

type VimIntegration = typeof import("./vim-integration");

/** The vimrc text of a state (see `EditorConfig.vimrc`); read by the lazily-loaded vim plugin. */
export const vimrcFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? "",
});

/**
 * Vim (`@replit/codemirror-vim` plus the app integration in ./vim-integration) is ~300 KB, so it
 * is loaded on demand: `vimMode(true)` yields nothing until the module arrives, then editors that
 * asked for it reconfigure (see `onVimLoaded`).
 */
let integration: VimIntegration | null = null;
let loading: Promise<VimIntegration> | null = null;
const loadedListeners = new Set<() => void>();

/**
 * Starts loading vim (idempotent). Hosts call this early when the user has vim mode on. Rejects if
 * the chunk can't be loaded; the next call (or enabling vim again) retries.
 */
export function preloadVim(): Promise<void> {
  loading ??= import("./vim-integration").then(
    (module) => {
      module.installVimIntegration();
      integration = module;
      for (const listener of [...loadedListeners]) listener();
      loadedListeners.clear();
      return module;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading.then(() => undefined);
}

export function isVimLoaded(): boolean {
  return integration !== null;
}

/** Calls `listener` once vim has loaded (immediately-resolved loads still notify asynchronously). */
export function onVimLoaded(listener: () => void): () => void {
  loadedListeners.add(listener);
  return () => loadedListeners.delete(listener);
}

/** Vim keybindings. Must be the first extension so its key handling runs before any keymap. */
export function vimMode(enabled: boolean): Extension {
  if (!enabled) return [];
  if (!integration) {
    // A failed load leaves vim off; it is retried the next time vim is (re)applied.
    preloadVim().catch(() => {});
    return [];
  }
  return integration.vimExtension();
}

/**
 * Whether a keydown inside a vim editor belongs to vim rather than to an app shortcut: in normal,
 * visual and operator-pending mode vim owns the Ctrl keys it binds (by default or through a
 * mapping). Insert mode, keys vim doesn't bind and every ⌘ shortcut stay with the app.
 */
export function vimClaimsKey(event: KeyboardEvent): boolean {
  return integration?.vimClaimsKey(event) ?? false;
}
