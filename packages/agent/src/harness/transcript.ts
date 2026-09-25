/**
 * Transcripts (`HarnessSessionOptions.transcript`) as text, for harnesses that can't seed a
 * session's messages: their first prompt carries the conversation instead.
 */
import type { TranscriptEntry } from "./types";

const MAX_RENDERED_CHARS = 60_000;
const MAX_RENDERED_RESULT = 2_000;

/**
 * A transcript as text, for harnesses that can't restore messages (their first prompt carries it).
 * Long results are shortened, and a very long conversation keeps its most recent part.
 */
export function renderTranscript(entries: readonly TranscriptEntry[]): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    switch (entry.role) {
      case "user":
        blocks.push(`[user]\n${entry.text}`);
        break;
      case "assistant":
        blocks.push(
          [
            "[you]",
            ...(entry.text ? [entry.text] : []),
            ...entry.toolCalls.map(
              (call) => `→ called ${call.name} ${clip(JSON.stringify(call.input ?? {}), 500)}`,
            ),
          ].join("\n"),
        );
        break;
      case "tool":
        blocks.push(
          `← ${entry.toolName}${entry.isError ? " (failed)" : ""}: ${clip(entry.output, MAX_RENDERED_RESULT)}`,
        );
        break;
    }
  }
  let kept = blocks;
  let size = kept.reduce((total, block) => total + block.length + 2, 0);
  while (kept.length > 1 && size > MAX_RENDERED_CHARS) {
    size -= kept[0]!.length + 2;
    kept = kept.slice(1);
  }
  return [
    "Your conversation so far on this task, restored after the agent restarted (oldest first):",
    ...(kept.length < blocks.length ? ["(earlier parts left out)"] : []),
    ...kept,
    "(end of the restored conversation)",
  ].join("\n\n");
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
