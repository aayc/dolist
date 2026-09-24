import { extname, isMarkdownPath } from "../paths";

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

/** Links to notes in `text`. Same-note links (`[[#Heading]]`) and blank targets are skipped. */
export function parseWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = m[2]!.trim();
    if (!target) continue;
    const link: WikiLink = {
      target,
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
 * Resolves a wikilink target like Obsidian, ignoring case and Unicode normalization: the exact
 * vault path first, then the shortest path that ends with it. `[[Plan]]` names `Plan.md`; a target
 * with another extension (`[[image.png]]`) may also name that file itself.
 */
export function resolveWikiLink(target: string, paths: readonly string[]): string | null {
  const wanted = fold(target.replace(/\\/g, "/").replace(/^\//, ""));
  if (!wanted) return null;
  const names = isMarkdownPath(wanted)
    ? [wanted]
    : extname(wanted)
      ? [`${wanted}.md`, wanted]
      : [`${wanted}.md`];
  let best: string | null = null;
  for (const p of paths) {
    const pl = fold(p);
    if (names.includes(pl)) return p;
    if (
      names.some((name) => pl.endsWith(`/${name}`)) &&
      (best === null || p.length < best.length)
    ) {
      best = p;
    }
  }
  return best;
}

function fold(path: string): string {
  return path.normalize("NFC").toLowerCase();
}
