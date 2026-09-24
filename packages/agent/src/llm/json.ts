export type JsonParseResult = { ok: true; value: unknown } | { ok: false };

const FENCED_BLOCK_RE = /```(?:json|JSON)?\s*([\s\S]*?)```/;

/**
 * Parses model output that should be JSON but may be wrapped in prose or a markdown fence:
 * tries the whole text, then the first fenced block, then the first balanced `{…}` object.
 */
export function parseJsonLoose(text: string): JsonParseResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false };
  const direct = tryParse(trimmed);
  if (direct.ok) return direct;
  const fenced = FENCED_BLOCK_RE.exec(trimmed)?.[1];
  if (fenced !== undefined) {
    const inner = tryParse(fenced.trim());
    if (inner.ok) return inner;
  }
  for (let start = trimmed.indexOf("{"); start !== -1; start = trimmed.indexOf("{", start + 1)) {
    const end = findBalancedObjectEnd(trimmed, start);
    if (end === -1) break;
    const candidate = tryParse(trimmed.slice(start, end + 1));
    if (candidate.ok) return candidate;
  }
  return { ok: false };
}

function tryParse(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Index of the `}` closing the object that opens at `start`, or -1. String-literal aware. */
function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
