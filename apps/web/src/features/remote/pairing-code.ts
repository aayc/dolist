import { normalizePairingCode, PAIRING_CODE_LENGTH } from "@ddl/core";

const HALF = PAIRING_CODE_LENGTH / 2;

function codeChars(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * A pairing code as it's typed or pasted: letters and digits only, uppercase, at most 8, shown as
 * XXXX-XXXX. `caret` is where the caret was in `raw`; the result says where it goes in `value`.
 */
export function formatCodeInput(raw: string, caret = raw.length): { value: string; caret: number } {
  const chars = codeChars(raw).slice(0, PAIRING_CODE_LENGTH);
  const before = Math.min(codeChars(raw.slice(0, caret)).length, chars.length);
  const value = chars.length > HALF ? `${chars.slice(0, HALF)}-${chars.slice(HALF)}` : chars;
  return { value, caret: before > HALF ? before + 1 : before };
}

/** Why a typed code can't be sent yet, or null when it's a code. */
export function codeProblem(value: string): string | null {
  if (normalizePairingCode(value)) return null;
  const chars = codeChars(value);
  if (chars.length < PAIRING_CODE_LENGTH) return `Enter all ${PAIRING_CODE_LENGTH} characters.`;
  return "Codes never use 0, 1, I, L, O or U: check the code.";
}
