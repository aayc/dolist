const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** Longest prefix of `text` that fits in `maxBytes` without splitting a UTF-8 sequence. */
export function utf8Head(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** Longest suffix of `text` that fits in `maxBytes` without splitting a UTF-8 sequence. */
export function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - Math.max(0, maxBytes);
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

export function truncationMarker(omittedBytes: number): string {
  return `\n\n[... ${omittedBytes} bytes of output omitted ...]\n\n`;
}

/**
 * Accumulates decoded output with bounded memory, keeping the first and last `maxBytes / 2`
 * bytes. Chunks must be whole characters (decode each stream with its own StringDecoder).
 */
export class HeadTailBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: string[] = [];
  private headBytes = 0;
  private headFull = false;
  private readonly tail: { text: string; bytes: number }[] = [];
  private tailBytes = 0;
  private totalBytes = 0;

  constructor(maxBytes: number) {
    const max = Math.max(2, Math.floor(maxBytes));
    this.headLimit = Math.floor(max / 2);
    this.tailLimit = max - this.headLimit;
  }

  get truncated(): boolean {
    return this.totalBytes > this.headLimit + this.tailLimit;
  }

  push(text: string): void {
    if (!text) return;
    const bytes = byteLength(text);
    this.totalBytes += bytes;
    let rest = text;
    if (!this.headFull) {
      const room = this.headLimit - this.headBytes;
      if (bytes <= room) {
        this.head.push(text);
        this.headBytes += bytes;
        return;
      }
      const part = utf8Head(text, room);
      this.head.push(part);
      this.headBytes += byteLength(part);
      this.headFull = true;
      rest = text.slice(part.length);
    }
    this.pushTail(rest);
  }

  private pushTail(text: string): void {
    if (!text) return;
    const bytes = byteLength(text);
    this.tail.push({ text, bytes });
    this.tailBytes += bytes;
    // Drop whole chunks only while the remaining ones still cover the tail budget.
    while (this.tail.length > 1 && this.tailBytes - (this.tail[0]?.bytes ?? 0) >= this.tailLimit) {
      this.tailBytes -= this.tail.shift()?.bytes ?? 0;
    }
  }

  toString(): string {
    const head = this.head.join("");
    const tail = this.tail.map((chunk) => chunk.text).join("");
    if (!this.truncated) return head + tail;
    const kept = utf8Tail(tail, this.tailLimit);
    const omitted = this.totalBytes - this.headBytes - byteLength(kept);
    return head + truncationMarker(omitted) + kept;
  }
}
