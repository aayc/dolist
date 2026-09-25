import type { Line, Text } from "@codemirror/state";
import { parseDrawingEmbed, parseWikiLinks } from "@ddl/core";
import type { BlockEmbed } from "./types";

/** Cheap pre-check: only lines that look like `![[…]]` (with optional spaces) are parsed. */
function looksLikeEmbedLine(text: string): boolean {
  const start = text.search(/\S/);
  return start !== -1 && text.startsWith("![[", start) && text.trimEnd().endsWith("]]");
}

/**
 * The embed a line consists of: one `![[…]]` and nothing else but whitespace. Its modifiers are
 * read with the Obsidian Excalidraw plugin's grammar (`@ddl/core`'s `parseDrawingEmbed`), which
 * image embeds share. O(line).
 */
export function embedOfLine(line: Pick<Line, "from" | "to" | "text">): BlockEmbed | null {
  if (!looksLikeEmbedLine(line.text)) return null;
  const links = parseWikiLinks(line.text);
  const link = links[0];
  if (links.length !== 1 || !link?.embed) return null;
  if (line.text.slice(0, link.from).trim() || line.text.slice(link.to).trim()) return null;
  const parsed = parseDrawingEmbed(link, { drawing: true });
  if (!parsed) return null;
  const { from, to, ...spec } = parsed;
  return {
    from: line.from + from,
    to: line.from + to,
    lineFrom: line.from,
    lineTo: line.to,
    text: line.text.slice(from, to),
    spec,
  };
}

/** The embed whose `![[` is at `pos`, or null when there's no longer one there. */
export function embedAt(doc: Text, pos: number): BlockEmbed | null {
  if (pos < 0 || pos > doc.length) return null;
  const embed = embedOfLine(doc.lineAt(pos));
  return embed?.from === pos ? embed : null;
}
