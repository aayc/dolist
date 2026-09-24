import type { AcpModel } from "./protocol";

export class CursorModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorModelError";
  }
}

/**
 * The CLI model id for a configured model: an exact `modelId`, else the same base id (the part
 * before `[parameters]`; configured parameters are kept, the CLI validates them), else a display
 * name, case-insensitively. Throws with a few available ids when nothing matches.
 */
export function resolveCursorModel(requested: string, available: readonly AcpModel[]): string {
  const wanted = requested.trim();
  if (!wanted) throw new CursorModelError("No Cursor model is configured");
  const exact = available.find((model) => model.modelId === wanted);
  if (exact) return exact.modelId;
  const base = baseId(wanted);
  const sameBase = available.find((model) => baseId(model.modelId) === base);
  if (sameBase) return wanted.includes("[") ? wanted : sameBase.modelId;
  const lower = wanted.toLowerCase();
  const named = available.find((model) => model.name.trim().toLowerCase() === lower);
  if (named) return named.modelId;
  const examples = available
    .slice(0, 6)
    .map((model) => baseId(model.modelId))
    .join(", ");
  throw new CursorModelError(
    `The Cursor model "${wanted}" isn't available to this Cursor account${examples ? ` (available: ${examples}${available.length > 6 ? ", …" : ""})` : ""}. Pick one from \`agent models\`.`,
  );
}

function baseId(modelId: string): string {
  const bracket = modelId.indexOf("[");
  return (bracket >= 0 ? modelId.slice(0, bracket) : modelId).trim().toLowerCase();
}
