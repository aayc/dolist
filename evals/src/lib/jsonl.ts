import { readFileSync } from "node:fs";

export interface JsonlEntry<T> {
  /** 1-based line number in the source file. */
  line: number;
  value: T;
}

export interface JsonlLoad<T> {
  entries: JsonlEntry<T>[];
  /** Parse errors, one per malformed line. */
  problems: string[];
}

/** Reads a `.jsonl` file, skipping blank lines and collecting per-line parse errors. */
export function loadJsonl<T = unknown>(path: string): JsonlLoad<T> {
  const entries: JsonlEntry<T>[] = [];
  const problems: string[] = [];
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((raw, index) => {
    if (!raw.trim()) return;
    try {
      entries.push({ line: index + 1, value: JSON.parse(raw) as T });
    } catch {
      problems.push(`line ${index + 1}: invalid JSON`);
    }
  });
  return { entries, problems };
}
