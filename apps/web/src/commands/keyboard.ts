import { vimClaimsKey } from "@ddl/editor";
import { IS_MAC } from "../lib/platform";
import { type CommandRegistry, runIsolated } from "./registry";

/**
 * Global hotkeys, registered in the capture phase so they win over the editor and over browser
 * defaults (e.g. Chrome's ⌘⇧D). Some browser shortcuts (⌘W, ⌘N, ⌘⇧N) cannot be intercepted in a
 * regular tab; they work in the native shells.
 *
 * Vim policy: where "Mod" is Ctrl (Windows/Linux), a vim editor in normal or visual mode keeps
 * the Ctrl keys vim binds (Ctrl-O, Ctrl-D, Ctrl-U, Ctrl-R, Ctrl-V, Ctrl-A, …); shortcuts vim
 * doesn't bind, insert mode and every ⌘ shortcut on macOS are unaffected.
 */
export function installGlobalHotkeys(registry: CommandRegistry, isMac = IS_MAC): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const command = registry.findByEvent(event, isMac);
    if (!command) return;
    if (!isMac && event.ctrlKey && !event.metaKey && vimClaimsKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    runIsolated(command, { event });
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
}
