/**
 * Vector key tokens (README "Keys") and the keyboard events a real keypress would carry for them.
 * The mapping round-trips through `Vim.vimKeyFromEvent`, except that the space bar produces
 * `<Space>` (the literal `" "` token has no keypress of its own).
 */

export interface KeySpec {
  /** `KeyboardEvent.key`. */
  key: string;
  keyCode: number;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const NAMED_KEYS: Record<string, { key: string; keyCode: number }> = {
  esc: { key: "Escape", keyCode: 27 },
  cr: { key: "Enter", keyCode: 13 },
  bs: { key: "Backspace", keyCode: 8 },
  del: { key: "Delete", keyCode: 46 },
  tab: { key: "Tab", keyCode: 9 },
  space: { key: " ", keyCode: 32 },
  up: { key: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", keyCode: 39 },
  home: { key: "Home", keyCode: 36 },
  end: { key: "End", keyCode: 35 },
  pageup: { key: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", keyCode: 34 },
  ins: { key: "Insert", keyCode: 45 },
  lt: { key: "<", keyCode: 188 },
};

/** Only letters and digits get their legacy key code; nothing reads the others. */
function keyCodeOf(char: string): number {
  const upper = char.toUpperCase();
  return /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0;
}

/**
 * Splits `"d2w<Esc>"` into `["d", "2", "w", "<Esc>"]`, one token per code point otherwise. A `<`
 * that starts no named key stays literal.
 */
export function splitKeys(keys: string): string[] {
  const tokens: string[] = [];
  const re = /<(?:[CSMA]-)+.>|<(?:[CSMA]-)*[A-Za-z][A-Za-z0-9]+>|[\s\S]/gu;
  for (const match of keys.matchAll(re)) tokens.push(match[0]);
  return tokens;
}

export function isNamedToken(token: string): boolean {
  return token.length > 2 && token.startsWith("<") && token.endsWith(">");
}

export function keySpecOf(token: string): KeySpec {
  const spec: KeySpec = {
    key: token,
    keyCode: keyCodeOf(token),
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
  };
  if (!isNamedToken(token)) return spec;
  const parts = token.slice(1, -1).split("-");
  let name = parts.pop() ?? "";
  // `<C-->` splits into ["C", "", ""]: the key itself is "-".
  if (name === "" && parts.at(-1) === "") {
    parts.pop();
    name = "-";
  }
  for (const modifier of parts) {
    if (modifier === "C") spec.ctrlKey = true;
    else if (modifier === "S") spec.shiftKey = true;
    else if (modifier === "A") spec.altKey = true;
    else if (modifier === "M") spec.metaKey = true;
  }
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) {
    spec.key = named.key;
    spec.keyCode = named.keyCode;
  } else {
    spec.key = name;
    spec.keyCode = keyCodeOf(name);
  }
  return spec;
}

/** Text a native keypress inserts in insert mode (README rule 2), or null. */
export function insertedText(token: string): string | null {
  if (!isNamedToken(token)) return token;
  switch (token) {
    case "<Space>":
    case "<S-Space>":
      return " ";
    case "<CR>":
      return "\n";
    case "<Tab>":
      return "\t";
    default:
      return null;
  }
}

/** Replace mode overwrites with the event's key when it is one UTF-16 unit (the adapter's rule). */
export function overwriteText(spec: KeySpec): string | null {
  return spec.key.length === 1 && spec.key !== "\n" ? spec.key : null;
}
