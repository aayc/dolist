import type { AcpModel } from "./protocol";

export class CursorModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorModelError";
  }
}

export interface ResolvedCursorModel {
  /** The CLI model id to run (one the session listed: agent mode rejects any other). */
  modelId: string;
  /**
   * The configured id when it names a variant agent mode can't run (`claude-opus-5-5-high-fast`,
   * `gpt-5.5[reasoning=high]`) and its model's preset runs instead.
   */
  presetFor?: string;
}

/** Variant parts of the ids `agent models` prints, after the model's base id. */
const VARIANT_SUFFIX = /-(?:fast|low|medium|high|xhigh|max|thinking|\d+[km])$/;

/**
 * The CLI model for a configured model. Agent mode lists one preset per model (a model id with
 * its parameters, e.g. `claude-opus-5-5[context=300k,effort=medium,fast=false]`) and accepts only
 * those ids, so: an exact listed id or display name, else the preset of the model the id names —
 * without `[parameters]`, variant suffixes or the `cursor-` prefix `agent models` uses. Throws with
 * a few available models when nothing matches.
 */
export function resolveCursorModel(
  requested: string,
  available: readonly AcpModel[],
): ResolvedCursorModel {
  const wanted = requested.trim();
  if (!wanted) throw new CursorModelError("No Cursor model is configured");
  const lower = wanted.toLowerCase();
  const exact =
    available.find((model) => model.modelId === wanted) ??
    available.find((model) => model.name.trim().toLowerCase() === lower);
  if (exact) return { modelId: exact.modelId };
  const [base, ...variants] = baseCandidates(wanted);
  const plain = available.find((model) => baseId(model.modelId) === base);
  if (plain) {
    return wanted.includes("[")
      ? { modelId: plain.modelId, presetFor: wanted }
      : { modelId: plain.modelId };
  }
  for (const candidate of variants) {
    const preset = available.find((model) => baseId(model.modelId) === candidate);
    if (preset) return { modelId: preset.modelId, presetFor: wanted };
  }
  const examples = available
    .slice(0, 6)
    .map((model) => baseId(model.modelId))
    .join(", ");
  throw new CursorModelError(
    `The Cursor model "${wanted}" isn't available to this Cursor account${examples ? ` (available: ${examples}${available.length > 6 ? ", …" : ""})` : ""}. Pick one from \`agent models\`.`,
  );
}

/** The id without `[parameters]`, then without its variant suffixes, most specific first. */
function baseCandidates(wanted: string): string[] {
  let id = baseId(wanted);
  const candidates = [id];
  while (VARIANT_SUFFIX.test(id)) {
    id = id.replace(VARIANT_SUFFIX, "");
    candidates.push(id);
  }
  for (const candidate of [...candidates]) {
    if (candidate.startsWith("cursor-")) candidates.push(candidate.slice("cursor-".length));
  }
  return candidates;
}

function baseId(modelId: string): string {
  const bracket = modelId.indexOf("[");
  return (bracket >= 0 ? modelId.slice(0, bracket) : modelId).trim().toLowerCase();
}
