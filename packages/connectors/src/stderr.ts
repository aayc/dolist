/**
 * Bounded buffer of a stdio server's recent stderr lines. It outlives individual processes, so the
 * output of a server that crashed on startup is still available for the status error message.
 */

import type { Stream } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export interface StderrBufferOptions {
  maxLines?: number;
  maxLineLength?: number;
  onLine?: (line: string) => void;
}

export class StderrBuffer {
  private readonly lines: string[] = [];
  private readonly maxLines: number;
  private readonly maxLineLength: number;
  private readonly onLine: ((line: string) => void) | undefined;

  constructor(options: StderrBufferOptions = {}) {
    this.maxLines = options.maxLines ?? 100;
    this.maxLineLength = options.maxLineLength ?? 2_000;
    this.onLine = options.onLine;
  }

  /** Captures a stream until it ends. */
  attach(stream: Stream | null): void {
    if (!stream) return;
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const onData = (chunk: Buffer | string) => {
      const lines = (pending + (typeof chunk === "string" ? chunk : decoder.write(chunk))).split(
        /\r\n|\r|\n/,
      );
      pending = lines.pop() ?? "";
      for (const line of lines) this.push(line);
      // Unterminated progress output must not grow without bound.
      if (pending.length > this.maxLineLength) {
        this.push(pending);
        pending = "";
      }
    };
    const onEnd = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("close", onEnd);
      this.push(pending + decoder.end());
      pending = "";
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onEnd);
  }

  push(line: string): void {
    const trimmed = line.trimEnd();
    if (trimmed === "") return;
    const clamped =
      trimmed.length > this.maxLineLength ? `${trimmed.slice(0, this.maxLineLength)}…` : trimmed;
    this.lines.push(clamped);
    if (this.lines.length > this.maxLines) this.lines.shift();
    this.onLine?.(clamped);
  }

  tail(count = 10): string[] {
    return this.lines.slice(-count);
  }
}
