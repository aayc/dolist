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
  const code = codeFor(hotkey.key);
  return code !== null && event.code === code;
}

const KEY_LABELS: Record<string, string> = {
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  Backspace: "⌫",
  " ": "Space",
};

export function formatHotkey(hotkey: Hotkey, isMac: boolean): string {
  const key =
    KEY_LABELS[hotkey.key] ?? (hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key);
  if (isMac) {
    return `${hotkey.ctrl ? "⌃" : ""}${hotkey.alt ? "⌥" : ""}${hotkey.shift ? "⇧" : ""}${hotkey.mod ? "⌘" : ""}${key}`;
  }
  const parts: string[] = [];
  if (hotkey.mod || hotkey.ctrl) parts.push("Ctrl");
  if (hotkey.alt) parts.push("Alt");
  if (hotkey.shift) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}
