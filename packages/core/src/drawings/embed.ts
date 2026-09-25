/**
 * Drawing embeds in notes, with the Obsidian Excalidraw plugin's modifiers:
 * `![[Plan.excalidraw|360|right-wrap]]`, `![[Plan.excalidraw|360x240]]`, `![[Plan.excalidraw|left]]`.
 * After the first `|` come an optional alias, an optional size (`360`, `360x240`, `x240`, `50%`)
 * and an optional style, which the plugin turns into the CSS class `excalidraw-svg-<style>`; the
 * styles below are the ones its stylesheet defines. No style means full width.
 */

import { parseWikiLinks, type WikiLink } from "../markdown/wikilinks";
import { basename } from "../paths";

export const DRAWING_PLACEMENTS = [
  "full",
  "left",
  "right",
  "center",
  "left-wrap",
  "right-wrap",
] as const;
export type DrawingPlacement = (typeof DRAWING_PLACEMENTS)[number];

export interface DrawingEmbedSpec {
  /** As written: `Plan.excalidraw` (Obsidian leaves out `.md`), or a path. */
  target: string;
  /** `#…` after the target (the plugin embeds parts of a drawing this way). */
  subpath?: string;
  alias?: string;
  /** Pixels. */
  width?: number;
  height?: number;
  /** Percent of the note's width, instead of `width`. */
  widthPercent?: number;
  heightPercent?: number;
  placement: DrawingPlacement;
  /** A style that isn't a placement, kept so writing the embed back doesn't drop it. */
  style?: string;
}

export interface DrawingEmbed extends DrawingEmbedSpec {
  /** Offsets of the whole `![[…]]` in the text it was found in. */
  from: number;
  to: number;
}

/** True when a link target names a drawing file (`Plan.excalidraw` or `Plan.excalidraw.md`). */
export function isDrawingTarget(target: string): boolean {
  return /\.excalidraw(\.md)?$/i.test(target.trim());
}

/**
 * The drawing embed `link` is, or null when it isn't an embed (`![[…]]`) of a drawing. A note
 * whose name doesn't say it's a drawing counts with `{ drawing: true }` (the caller checked the
 * file, e.g. with `isDrawingMarkdown`).
 */
export function parseDrawingEmbed(
  link: WikiLink,
  options: { drawing?: boolean } = {},
): DrawingEmbed | null {
  if (!link.embed || !(options.drawing || isDrawingTarget(link.target))) return null;
  const embed: DrawingEmbed = {
    target: link.target,
    placement: "full",
    from: link.from,
    to: link.to,
  };
  if (link.subpath !== undefined) embed.subpath = link.subpath;
  if (link.alias === undefined) return embed;

  const { alias, size, style } = splitAlias(link.alias.split("|").map((part) => part.trim()));
  if (alias) embed.alias = alias;
  if (size) Object.assign(embed, size);
  if (style) {
    if (isPlacement(style) && style !== "full") embed.placement = style;
    else embed.style = style;
  }
  return embed;
}

/** Every drawing embed in `text`, in order. */
export function findDrawingEmbeds(text: string): DrawingEmbed[] {
  const out: DrawingEmbed[] = [];
  for (const link of parseWikiLinks(text)) {
    const embed = parseDrawingEmbed(link);
    if (embed) out.push(embed);
  }
  return out;
}

/** The `![[…]]` text for an embed, in the order the plugin reads its parts back. */
export function formatDrawingEmbed(embed: DrawingEmbedSpec): string {
  const size = sizeText(embed);
  const style = embed.placement !== "full" ? embed.placement : embed.style;
  const parts = [embed.alias, size, style].filter((part): part is string => !!part);
  const subpath = embed.subpath === undefined ? "" : `#${embed.subpath}`;
  return `![[${embed.target}${subpath}${parts.map((part) => `|${part}`).join("")}]]`;
}

/**
 * How to link to a drawing from a note, like Obsidian's default "shortest path when possible":
 * the file name without `.md`, or the whole path when another file in `paths` has the same name.
 */
export function drawingLinkTarget(path: string, paths: readonly string[] = []): string {
  const withoutMd = path.replace(/\.md$/i, "");
  const name = basename(path).toLowerCase();
  const clash = paths.some((other) => other !== path && basename(other).toLowerCase() === name);
  return clash ? withoutMd : basename(withoutMd);
}

function isPlacement(style: string): style is DrawingPlacement {
  return (DRAWING_PLACEMENTS as readonly string[]).includes(style);
}

type Size = Pick<DrawingEmbedSpec, "width" | "height" | "widthPercent" | "heightPercent">;

/** The plugin's `parseAlias`: which of the `|` parts is the alias, the size and the style. */
function splitAlias(parts: string[]): { alias?: string; size?: Size; style?: string } {
  const [first = "", second = ""] = parts;
  const last = parts[parts.length - 1] ?? "";
  switch (parts.length) {
    case 1: {
      const size = parseSize(first);
      return size ? { size } : { style: first };
    }
    case 2: {
      const secondSize = parseSize(second);
      if (secondSize) return { alias: first, size: secondSize };
      const firstSize = parseSize(first);
      if (firstSize) return { size: firstSize, style: second };
      return { alias: first, style: second };
    }
    default: {
      const size = parseSize(second);
      return size ? { alias: first, size, style: last } : { alias: first, style: last };
    }
  }
}

/** `360`, `360x240`, `x240`, `50%`, `50%x200`; a value starting with 0 must be `0` itself. */
function parseSize(part: string): Size | null {
  const match = /^(?:(\d+%?)(?:x(\d+%?))?|x(\d+%?))$/.exec(part);
  if (!match) return null;
  const width = match[1];
  const height = match[2] ?? match[3];
  if ([width, height].some((value) => value?.startsWith("0") && value !== "0")) return null;
  const size: Size = {};
  if (width !== undefined) {
    if (width.endsWith("%")) size.widthPercent = Number(width.slice(0, -1));
    else size.width = Number(width);
  }
  if (height !== undefined) {
    if (height.endsWith("%")) size.heightPercent = Number(height.slice(0, -1));
    else size.height = Number(height);
  }
  return size;
}

function sizeText(embed: DrawingEmbedSpec): string {
  const width =
    embed.widthPercent !== undefined
      ? `${embed.widthPercent}%`
      : embed.width !== undefined
        ? String(Math.round(embed.width))
        : "";
  const height =
    embed.heightPercent !== undefined
      ? `${embed.heightPercent}%`
      : embed.height !== undefined
        ? String(Math.round(embed.height))
        : "";
  return height ? `${width}x${height}` : width;
}
