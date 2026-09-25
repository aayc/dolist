import { type DrawingElement, newDrawingElementId } from "@ddl/core";

/** The Obsidian plugin's element ids: 8 characters from [0-9a-zA-Z]. */
const PLUGIN_ID = /^[0-9a-zA-Z]{8}$/;

type Rename = (id: string) => string;

function renameBinding(binding: unknown, rename: Rename): unknown {
  if (typeof binding !== "object" || binding === null) return binding;
  const { elementId } = binding as { elementId?: unknown };
  if (typeof elementId !== "string" || rename(elementId) === elementId) return binding;
  return { ...binding, elementId: rename(elementId) };
}

/** `element` with its id and its references to other elements renamed (the same object if none). */
function renameElement(element: DrawingElement, rename: Rename): DrawingElement {
  const next: DrawingElement = { ...element, id: rename(element.id) };
  let changed = next.id !== element.id;
  for (const key of ["containerId", "frameId"] as const) {
    const value = element[key];
    if (typeof value === "string" && rename(value) !== value) {
      next[key] = rename(value);
      changed = true;
    }
  }
  for (const key of ["startBinding", "endBinding"] as const) {
    const renamed = renameBinding(element[key], rename);
    if (renamed !== element[key]) {
      next[key] = renamed;
      changed = true;
    }
  }
  if (Array.isArray(element.boundElements)) {
    const bound = element.boundElements.map((entry) =>
      typeof entry?.id === "string" && rename(entry.id) !== entry.id
        ? { ...entry, id: rename(entry.id) }
        : entry,
    );
    if (bound.some((entry, i) => entry !== element.boundElements?.[i])) {
      next.boundElements = bound;
      changed = true;
    }
  }
  return changed ? next : element;
}

/**
 * Excalidraw names new elements with 21-character ids, and the Obsidian plugin gives new ids to
 * those that aren't 8 characters of [0-9a-zA-Z] when it opens the file. So the file gets the
 * plugin's ids while the editor keeps its own for the session, translated both ways here.
 */
export class ElementIds {
  private readonly toFile = new Map<string, string>();
  private readonly toLocal = new Map<string, string>();
  private readonly newId: () => string;

  constructor(newId: () => string = newDrawingElementId) {
    this.newId = newId;
  }

  /** The elements as the file names them. */
  file(elements: readonly DrawingElement[]): DrawingElement[] {
    const taken = new Set<string>(this.toLocal.keys());
    for (const element of elements) if (PLUGIN_ID.test(element.id)) taken.add(element.id);
    for (const element of elements) {
      if (PLUGIN_ID.test(element.id) || this.toFile.has(element.id)) continue;
      let id = this.newId();
      while (taken.has(id)) id = this.newId();
      taken.add(id);
      this.toFile.set(element.id, id);
      this.toLocal.set(id, element.id);
    }
    const rename = (id: string) => this.toFile.get(id) ?? id;
    return elements.map((element) => renameElement(element, rename));
  }

  /** Elements from the file, as the editor names them. */
  local(elements: readonly DrawingElement[]): DrawingElement[] {
    const rename = (id: string) => this.toLocal.get(id) ?? id;
    return elements.map((element) => renameElement(element, rename));
  }

  /** The file's name for an editor id. */
  fileId(id: string): string {
    return this.toFile.get(id) ?? id;
  }
}
