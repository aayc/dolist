/**
 * Merging two edits of the same drawing: the local editor's and a newer file (from Obsidian,
 * another device, sync). Elements are matched by id and the newer edit of each wins, by
 * Excalidraw's rule (higher `version`; on a tie, lower `versionNonce`). `base`, the file both
 * sides started from, tells a deletion from an addition: files don't keep deleted elements, so an
 * element one side dropped and the other didn't touch is gone, while one the other side changed
 * survives. Nothing either side changed is lost.
 */
import type { DrawingBinaryFiles, DrawingElement } from "./types";

export interface MergeDrawingOptions {
  /** Elements being edited locally right now (a text being typed): the local copy wins. */
  editing?: ReadonlySet<string>;
}

function version(element: DrawingElement): number {
  return typeof element.version === "number" ? element.version : 0;
}

function nonce(element: DrawingElement): number {
  return typeof element.versionNonce === "number" ? element.versionNonce : 0;
}

/** The newer of two edits of one element; `remote` when they're the same edit. */
export function newerDrawingElement(local: DrawingElement, remote: DrawingElement): DrawingElement {
  if (version(local) !== version(remote)) return version(local) > version(remote) ? local : remote;
  return nonce(local) < nonce(remote) ? local : remote;
}

function byId(elements: readonly DrawingElement[]): Map<string, DrawingElement> {
  return new Map(elements.map((element) => [element.id, element]));
}

/**
 * The merged element list: `remote`'s order, with elements only `local` has placed after the
 * element before them in `local`, then sorted by fractional `index` when every element has one
 * (Excalidraw's stacking order). Deleted elements (`isDeleted`) take part like any other edit.
 */
export function mergeDrawingElements(
  base: readonly DrawingElement[],
  local: readonly DrawingElement[],
  remote: readonly DrawingElement[],
  options: MergeDrawingOptions = {},
): DrawingElement[] {
  const baseById = byId(base);
  const localById = byId(local);
  const remoteById = byId(remote);
  const editing = options.editing;

  const pick = (id: string): DrawingElement | null => {
    const mine = localById.get(id);
    const theirs = remoteById.get(id);
    const before = baseById.get(id);
    if (mine && theirs) return editing?.has(id) ? mine : newerDrawingElement(mine, theirs);
    if (mine) return before && version(before) === version(mine) ? null : mine;
    if (theirs) return before && version(before) === version(theirs) ? null : theirs;
    return null;
  };

  const order: string[] = remote.map((element) => element.id);
  const placed = new Set(order);
  let previous: string | null = null;
  for (const element of local) {
    if (!placed.has(element.id)) {
      const at = previous === null ? -1 : order.indexOf(previous);
      order.splice(at + 1, 0, element.id);
      placed.add(element.id);
    }
    previous = element.id;
  }

  const merged: DrawingElement[] = [];
  for (const id of order) {
    const element = pick(id);
    if (element) merged.push(element);
  }
  if (merged.every((element) => typeof element.index === "string")) {
    const position = new Map(merged.map((element, i) => [element, i]));
    merged.sort((a, b) => {
      const ai = a.index as string;
      const bi = b.index as string;
      return ai < bi ? -1 : ai > bi ? 1 : position.get(a)! - position.get(b)!;
    });
  }
  return merged;
}

/** Images from both sides; the local copy of one both have. */
export function mergeDrawingFiles(
  local: DrawingBinaryFiles,
  remote: DrawingBinaryFiles,
): DrawingBinaryFiles {
  return { ...remote, ...local };
}
