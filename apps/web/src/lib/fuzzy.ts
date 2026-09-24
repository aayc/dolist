/**
 * Fast fuzzy matcher for the command palette and quick switcher. Scores subsequence matches,
 * rewarding word-boundary hits, consecutive runs and early matches. Linear in the target length:
 * a few alignment candidates are scored instead of running a full DP alignment.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the target of the matched characters (for highlighting). */
  indices: number[];
}

export interface FuzzyResult<T> extends FuzzyMatch {
  item: T;
}

const SEPARATORS = " /\\-_.:([{#";

function isBoundary(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1]!;
  const cur = target[i]!;
  if (SEPARATORS.includes(prev)) return true;
  if (prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z") return true;
  const prevDigit = prev >= "0" && prev <= "9";
  const curDigit = cur >= "0" && cur <= "9";
  return curDigit && !prevDigit;
}

function scoreIndices(target: string, query: string, indices: readonly number[]): number {
  let score = 0;
  let prev = -2;
  let streak = 0;
  let runStartsWord = false;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    const boundary = isBoundary(target, i);
    score += 1;
    if (i === 0) score += 8;
    else if (boundary) score += 6;
    if (i === prev + 1) {
      streak++;
      score += 3 + Math.min(streak, 4);
      // A word prefix ("tod" in "today") beats the same letters scattered over word starts.
      if (runStartsWord) score += 3;
    } else {
      streak = 0;
      runStartsWord = boundary;
      if (k > 0) score -= Math.min(i - prev - 1, 6) * 0.4;
    }
    if (target[i] === query[k]) score += 0.25;
    prev = i;
  }
  return score - target.length * 0.01;
}

/** Latest index at which query[k] may match while the rest of the query still fits after it. */
function latestPositions(lower: string, q: string): number[] | null {
  const last = new Array<number>(q.length);
  let k = q.length - 1;
  for (let i = lower.length - 1; i >= 0 && k >= 0; i--) {
    if (lower[i] === q[k]) {
      last[k] = i;
      k--;
    }
  }
  return k >= 0 ? null : last;
}

function greedy(lower: string, q: string): number[] {
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i < lower.length && k < q.length; i++) {
    if (lower[i] === q[k]) {
      out.push(i);
      k++;
    }
  }
  return out;
}

function boundaryPreferring(target: string, lower: string, q: string, last: number[]): number[] {
  const out: number[] = [];
  let pos = 0;
  for (let k = 0; k < q.length; k++) {
    const ch = q[k]!;
    const limit = last[k]!;
    let chosen = -1;
    const prev = out[k - 1];
    if (prev !== undefined && lower[prev + 1] === ch && prev + 1 <= limit) chosen = prev + 1;
    if (chosen === -1) {
      let first = -1;
      for (let i = pos; i <= limit; i++) {
        if (lower[i] !== ch) continue;
        if (first === -1) first = i;
        if (isBoundary(target, i)) {
          chosen = i;
          break;
        }
      }
      chosen = chosen === -1 ? first : chosen;
    }
    if (chosen === -1) return greedy(lower, q);
    out.push(chosen);
    pos = chosen + 1;
  }
  return out;
}

/**
 * Lowercase with exactly one output unit per input unit (so indices stay valid in `text`) and
 * without context: "İ" lowercases to "i" + U+0307, and Σ to ς at the end of a word.
 */
function foldCase(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length && !text.includes("Σ")) return lower;
  let out = "";
  for (const ch of text) out += ch.toLowerCase().slice(0, ch.length);
  return out;
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = foldCase(query.replace(/\s+/g, ""));
  if (!q) return { score: 0, indices: [] };
  if (q.length > target.length) return null;
  const lower = foldCase(target);
  const last = latestPositions(lower, q);
  if (!last) return null;

  const candidates: number[][] = [greedy(lower, q), boundaryPreferring(target, lower, q, last)];
  let at = lower.indexOf(q);
  for (let n = 0; at !== -1 && n < 8; n++) {
    candidates.push(Array.from({ length: q.length }, (_, k) => at + k));
    at = lower.indexOf(q, at + 1);
  }

  let best: FuzzyMatch | null = null;
  for (const indices of candidates) {
    if (indices.length !== q.length) continue;
    const score = scoreIndices(target, query.replace(/\s+/g, ""), indices);
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

/** Filters and ranks `items` by fuzzy score (descending); ties prefer shorter keys. */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string,
  limit = 50,
): FuzzyResult<T>[] {
  const out: Array<FuzzyResult<T> & { len: number }> = [];
  for (const item of items) {
    const text = key(item);
    const match = fuzzyMatch(query, text);
    if (match) out.push({ item, score: match.score, indices: match.indices, len: text.length });
  }
  out.sort((a, b) => b.score - a.score || a.len - b.len);
  return out.slice(0, limit).map(({ len: _len, ...rest }) => rest);
}
