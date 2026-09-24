/**
 * Key combos and text → macOS keyboard event sequences (virtual keycodes are ANSI-layout positions).
 * Pure so the parsing can be tested anywhere; the JXA script only replays the steps.
 */

export type ModifierName = "cmd" | "shift" | "alt" | "ctrl" | "fn";

interface Modifier {
  code: number;
  flag: number;
}

/** CGEventFlags masks and the left-hand modifier keycodes. */
const MODIFIERS: Record<ModifierName, Modifier> = {
  cmd: { code: 55, flag: 0x100000 },
  shift: { code: 56, flag: 0x20000 },
  alt: { code: 58, flag: 0x80000 },
  ctrl: { code: 59, flag: 0x40000 },
  fn: { code: 63, flag: 0x800000 },
};

const MODIFIER_ALIASES: Record<string, ModifierName> = {
  cmd: "cmd",
  command: "cmd",
  meta: "cmd",
  super: "cmd",
  win: "cmd",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  fn: "fn",
};

const LETTERS = "asdfhgzxcv?bqweryt"; // keycodes 0–17 (10 is ISO-only)
const KEYCODES: Record<string, number> = {
  o: 31,
  u: 32,
  i: 34,
  p: 35,
  l: 37,
  j: 38,
  k: 40,
  n: 45,
  m: 46,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "9": 25,
  "7": 26,
  "8": 28,
  "0": 29,
  "=": 24,
  "-": 27,
  "]": 30,
  "[": 33,
  "'": 39,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  ".": 47,
  "`": 50,
  return: 36,
  enter: 36,
  tab: 48,
  space: 49,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  forwarddelete: 117,
  del: 117,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  left: 123,
  arrowleft: 123,
  right: 124,
  arrowright: 124,
  down: 125,
  arrowdown: 125,
  up: 126,
  arrowup: 126,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  minus: 27,
  equal: 24,
  plus: 24,
};
for (const [index, letter] of [...LETTERS].entries()) {
  if (letter !== "?") KEYCODES[letter] = index;
}

export interface KeyCombo {
  modifiers: ModifierName[];
  /** Normalized name of the non-modifier key. */
  key: string;
  code: number;
  /** Combined CGEventFlags for the key event. */
  flags: number;
}

export interface KeyEventStep {
  code: number;
  down: boolean;
  flags: number;
}

export class KeyComboError extends Error {
  override name = "KeyComboError";
}

function splitCombo(combo: string): string[] {
  const trimmed = combo.trim().toLowerCase();
  if (trimmed === "+") return ["+"];
  if (trimmed.includes("+")) {
    return trimmed.endsWith("++")
      ? [...trimmed.slice(0, -2).split("+"), "+"]
      : trimmed.split("+").map((part) => part.trim());
  }
  // macOS notation: "cmd-shift-4" (but a lone "-" is the minus key).
  if (/^(?:cmd|command|ctrl|control|alt|option|opt|shift|fn)-./.test(trimmed)) {
    return trimmed.endsWith("--") ? [...trimmed.slice(0, -2).split("-"), "-"] : trimmed.split("-");
  }
  return trimmed.split(/\s+/);
}

/** Parses `cmd+shift+4`, `Enter`, `ctrl+alt+delete`, `cmd-c`, `f5`… */
export function parseKeyCombo(combo: string): KeyCombo {
  const parts = splitCombo(combo);
  if (parts.length === 0 || parts.some((part) => part === "")) {
    throw new KeyComboError(`Invalid key combo: "${combo}"`);
  }
  const modifiers: ModifierName[] = [];
  let key: string | undefined;
  for (const [index, part] of parts.entries()) {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier && index < parts.length - 1) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (key !== undefined || modifier) {
      throw new KeyComboError(
        `Invalid key combo "${combo}": use modifiers (cmd, ctrl, alt, shift, fn) plus exactly one key.`,
      );
    }
    key = part === "+" ? "plus" : part;
  }
  if (key === undefined) throw new KeyComboError(`Invalid key combo: "${combo}"`);
  const code = KEYCODES[key];
  if (code === undefined) {
    throw new KeyComboError(
      `Unknown key "${key}" in "${combo}". Use letters, digits, punctuation, return, tab, space, escape, delete, arrows, home/end, pageup/pagedown or f1–f12.`,
    );
  }
  if (key === "plus" && !modifiers.includes("shift")) modifiers.push("shift");
  const flags = modifiers.reduce((acc, name) => acc | MODIFIERS[name].flag, 0);
  return { modifiers, key, code, flags };
}

/** Modifier downs, key down/up with flags, modifier ups in reverse — as a physical keyboard would. */
export function keyComboEvents(combo: KeyCombo): KeyEventStep[] {
  const steps: KeyEventStep[] = [];
  let flags = 0;
  for (const name of combo.modifiers) {
    flags |= MODIFIERS[name].flag;
    steps.push({ code: MODIFIERS[name].code, down: true, flags });
  }
  steps.push({ code: combo.code, down: true, flags: combo.flags });
  steps.push({ code: combo.code, down: false, flags: combo.flags });
  for (const name of [...combo.modifiers].reverse()) {
    flags &= ~MODIFIERS[name].flag;
    steps.push({ code: MODIFIERS[name].code, down: false, flags });
  }
  return steps;
}

export type TypingStep = { text: string } | { code: number };

/** Max UTF-16 units per synthesized keyboard event (CGEventKeyboardSetUnicodeString limit). */
export const MAX_UNICODE_CHUNK = 20;

/**
 * Splits text into unicode chunks (never splitting surrogate pairs) with newline → Return and
 * tab → Tab key presses, which apps handle more reliably than literal control characters.
 */
export function typingSteps(text: string, maxChunk = MAX_UNICODE_CHUNK): TypingStep[] {
  const steps: TypingStep[] = [];
  let chunk = "";
  const flush = () => {
    if (chunk) steps.push({ text: chunk });
    chunk = "";
  };
  for (const char of text.replace(/\r\n?/g, "\n")) {
    if (char === "\n" || char === "\t") {
      flush();
      steps.push({ code: char === "\n" ? 36 : 48 });
      continue;
    }
    if (chunk.length + char.length > maxChunk) flush();
    chunk += char;
  }
  flush();
  return steps;
}

/** Display form for approval cards and logs, e.g. `Cmd+Shift+4`. */
export function formatKeyCombo(combo: KeyCombo): string {
  const label = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
  return [...combo.modifiers.map(label), label(combo.key)].join("+");
}
