/** "Mod" = ⌘ on Apple platforms, Ctrl elsewhere (Obsidian's convention). */
export interface Hotkey {
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Literal Control on macOS (on other platforms use `mod`). */
  ctrl?: boolean;
  /** Lowercase character (`d`, `,`, `\`) or a `KeyboardEvent.key` name (`Escape`, `ArrowLeft`). */
  key: string;
}

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Parses "Mod+Shift+D", "Mod+\\", "Escape". */
export function parseHotkey(spec: string): Hotkey {
  const parts = spec.split("+");
  const rawKey = parts.pop() ?? "";
  const hotkey: Hotkey = { key: rawKey.length === 1 ? rawKey.toLowerCase() : rawKey };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "mod":
      case "cmd":
        hotkey.mod = true;
        break;
      case "shift":
        hotkey.shift = true;
        break;
      case "alt":
      case "option":
        hotkey.alt = true;
        break;
      case "ctrl":
        hotkey.ctrl = true;
        break;
      default:
        throw new Error(`Unknown modifier "${part}" in hotkey "${spec}"`);
    }
  }
  return hotkey;
}

const SYMBOL_CODES: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
};

/** Physical key for layout-independent fallback matching (non-Latin layouts, ⌥ on macOS). */
function codeFor(key: string): string | null {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return SYMBOL_CODES[key] ?? null;
}

export function matchHotkey(hotkey: Hotkey, event: KeyLike, isMac: boolean): boolean {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (Boolean(hotkey.mod) !== mod) return false;
  if (Boolean(hotkey.shift) !== event.shiftKey) return false;
  if (Boolean(hotkey.alt) !== event.altKey) return false;
  if (isMac ? Boolean(hotkey.ctrl) !== event.ctrlKey : event.metaKey) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key === hotkey.key) return true;
  // A Latin letter is what the layout produced (Dvorak ⌘B sits on the physical N key); only
  // other characters (Cyrillic, ⌥-symbols, dead keys, shifted digits) fall back to the key position.
  if (/^[a-z]$/.test(key)) return false;
  const code = codeFor(hotkey.key);
  return code !== null && event.code === code;
}

const MAC_KEYS: Record<string, string> = { Escape: "⎋", Enter: "↩", Tab: "⇥", Backspace: "⌫" };
const OTHER_KEYS: Record<string, string> = { Escape: "Esc" };
const SHARED_KEYS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  " ": "Space",
};

/** One label per keycap, modifiers first: `⇧ ⌘ D` (Apple order ⌃⌥⇧⌘) or `Ctrl Shift D`. */
export function hotkeyKeys(hotkey: Hotkey, isMac: boolean): string[] {
  const { key } = hotkey;
  const modifiers = isMac
    ? [hotkey.ctrl && "⌃", hotkey.alt && "⌥", hotkey.shift && "⇧", hotkey.mod && "⌘"]
    : [(hotkey.mod || hotkey.ctrl) && "Ctrl", hotkey.alt && "Alt", hotkey.shift && "Shift"];
  const label =
    (isMac ? MAC_KEYS : OTHER_KEYS)[key] ??
    SHARED_KEYS[key] ??
    (key.length === 1 ? key.toUpperCase() : key);
  return [...modifiers.filter((m): m is string => Boolean(m)), label];
}

export function formatHotkey(hotkey: Hotkey, isMac: boolean): string {
  return hotkeyKeys(hotkey, isMac).join(isMac ? "" : "+");
}

/** The `aria-keyshortcuts` value: "Meta+Shift+D" on Apple platforms, "Control+Shift+D" elsewhere. */
export function ariaKeyShortcuts(hotkey: Hotkey, isMac: boolean): string {
  const { key } = hotkey;
  const parts = [
    (hotkey.ctrl || (hotkey.mod && !isMac)) && "Control",
    hotkey.mod && isMac && "Meta",
    hotkey.alt && "Alt",
    hotkey.shift && "Shift",
    key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key,
  ];
  return parts.filter(Boolean).join("+");
}

/**
 * Keys that are affordances without being commands (Enter sends, Escape closes). Tooltips and hints
 * show them as keycaps by name, never as free text.
 */
export const KEYS = {
  enter: parseHotkey("Enter"),
  shiftEnter: parseHotkey("Shift+Enter"),
  modEnter: parseHotkey("Mod+Enter"),
  escape: parseHotkey("Escape"),
  up: parseHotkey("ArrowUp"),
  down: parseHotkey("ArrowDown"),
} satisfies Record<string, Hotkey>;

export type KeyName = keyof typeof KEYS;
