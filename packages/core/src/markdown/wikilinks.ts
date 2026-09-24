import { basename, stem } from "../paths";

export interface WikiLink {
  /** Link target without heading/block suffix, e.g. `Daily/2026-06-19`. */
  target: string;
  /** `#heading` or `#^block` suffix without the `#`, if any. */
  subpath?: string;
  alias?: string;
  embed: boolean;
  from: number;
  to: number;
}

const WIKILINK_RE = /(!?)\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?]]/g;

export function parseWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const link: WikiLink = {
      target: m[2]!.trim(),
      embed: m[1] === "!",
      from: m.index,
      to: m.index + m[0].length,
    };
    if (m[3]) link.subpath = m[3].trim();
    if (m[4]) link.alias = m[4].trim();
    out.push(link);
  }
  return out;
}

/**
 * Resolves a wikilink target like Obsidian: exact vault path (with or without `.md`) first,
 * then the shortest path whose file stem matches (case-insensitive).
 */
export function resolveWikiLink(target: string, paths: readonly string[]): string | null {
  const wanted = target.replace(/\\/g, "/").replace(/^\//, "");
  const withMd = wanted.toLowerCase().endsWith(".md") ? wanted : `${wanted}.md`;
  const lower = withMd.toLowerCase();
  let best: string | null = null;
  for (const p of paths) {
    const pl = p.toLowerCase();
    if (pl === lower) return p;
    if (
      pl.endsWith(`/${lower}`) ||
      stem(p).toLowerCase() === stem(basename(wanted)).toLowerCase()
    ) {
      if (!best || p.length < best.length) best = p;
    }
  }
  return best;
}
