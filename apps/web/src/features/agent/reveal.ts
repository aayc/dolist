/**
 * The typing reveal of agent text, shared with the macOS app (change both together): each frame
 * shows `revealCount(backlog, dt)` more grapheme clusters of what has arrived, so text never trails
 * what arrived by much more than a second, short replies type out visibly and long ones catch up.
 */

export const REVEAL_MIN_SPEED = 45;
export const REVEAL_MAX_SPEED = 3000;
/** Seconds the reveal may trail what arrived: the speed clears the backlog in about this long. */
export const REVEAL_LAG_SECONDS = 1;

/**
 * Grapheme clusters to reveal this frame, with `backlog` received but not yet shown and `dt`
 * seconds since the last frame: `max(1, round(speed × dt))` at
 * `speed = clamp(backlog / 1 s, 45, 3000)` per second, never more than the backlog.
 */
export function revealCount(backlog: number, dt: number): number {
  if (!(backlog > 0)) return 0;
  const speed = Math.min(
    REVEAL_MAX_SPEED,
    Math.max(REVEAL_MIN_SPEED, backlog / REVEAL_LAG_SECONDS),
  );
  const seconds = dt > 0 ? dt : 0;
  return Math.min(backlog, Math.max(1, Math.round(speed * seconds)));
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** `text` cut into grapheme clusters (code points where `Intl.Segmenter` is missing). */
export function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

/**
 * What of a growing text is shown, cut at grapheme boundaries. `update` takes the text received so
 * far; `step` reveals the next part. Appended text joins the backlog (a cluster still pending may
 * continue into it, like an emoji's skin tone); a text that doesn't extend the last one (a final
 * message repairing a gap) keeps the shown part it still starts with.
 */
export class TypeReveal {
  private text: string;
  private shownEnd: number;
  /** UTF-16 end offsets of the pending clusters; `ends[head]` is the next one to show. */
  private ends: number[] = [];
  private head = 0;

  /** `revealed`: how much of `text` starts out shown (all of it for history). */
  constructor(text = "", revealed = text.length) {
    this.text = text;
    this.shownEnd = boundaryAtOrBefore(text, Math.max(0, Math.min(revealed, text.length)));
    this.segmentFrom(this.shownEnd);
  }

  get target(): string {
    return this.text;
  }

  get shown(): string {
    return this.text.slice(0, this.shownEnd);
  }

  /** Grapheme clusters received but not shown yet. */
  get backlog(): number {
    return this.ends.length - this.head;
  }

  get caughtUp(): boolean {
    return this.backlog === 0;
  }

  update(text: string): void {
    if (text === this.text) return;
    if (text.startsWith(this.text)) {
      const pending = this.backlog;
      const from = pending < 2 ? this.shownEnd : this.ends[this.ends.length - 2]!;
      this.text = text;
      this.ends.length = this.head + Math.max(0, pending - 1);
      this.segmentFrom(from);
      return;
    }
    let common = 0;
    const limit = Math.min(this.shownEnd, text.length);
    while (common < limit && text.charCodeAt(common) === this.text.charCodeAt(common)) common++;
    this.text = text;
    this.shownEnd = boundaryAtOrBefore(text, common);
    this.ends = [];
    this.head = 0;
    this.segmentFrom(this.shownEnd);
  }

  /** Reveals the next clusters for a frame `dt` seconds after the last; returns how many. */
  step(dt: number): number {
    const count = revealCount(this.backlog, dt);
    if (count === 0) return 0;
    this.head += count;
    this.shownEnd = this.ends[this.head - 1] ?? this.shownEnd;
    if (this.head > 512) {
      this.ends = this.ends.slice(this.head);
      this.head = 0;
    }
    return count;
  }

  /** Shows everything received. */
  finish(): void {
    this.shownEnd = this.text.length;
    this.ends = [];
    this.head = 0;
  }

  private segmentFrom(from: number): void {
    let offset = from;
    for (const cluster of graphemes(this.text.slice(from))) {
      offset += cluster.length;
      this.ends.push(offset);
    }
  }
}

/** The last grapheme boundary of `text` at or before `index`. */
function boundaryAtOrBefore(text: string, index: number): number {
  if (index >= text.length) return text.length;
  let offset = 0;
  for (const cluster of graphemes(text)) {
    if (offset + cluster.length > index) break;
    offset += cluster.length;
  }
  return offset;
}
