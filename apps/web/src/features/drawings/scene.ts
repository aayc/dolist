import type { DrawingAppState, DrawingBinaryFiles, DrawingElement, DrawingScene } from "@ddl/core";

/** The editor's view settings a drawing file keeps; the rest of its app state is per session. */
const FILE_APP_STATE = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled"] as const;

/** What the editor holds: every element (deleted ones too, for merging), its app state, images. */
export interface EditorScene {
  elements: readonly DrawingElement[];
  appState: Readonly<Record<string, unknown>>;
  files: DrawingBinaryFiles;
}

export function fileAppState(appState: Readonly<Record<string, unknown>>): DrawingAppState {
  const out: Record<string, unknown> = {};
  for (const key of FILE_APP_STATE) if (appState[key] !== undefined) out[key] = appState[key];
  return out as DrawingAppState;
}

/**
 * The scene to write: live elements (files don't keep deleted ones), the images they show, and the
 * view settings. `serializeDrawingFile` fills in what the previous file had and this lacks.
 */
export function sceneForFile(
  elements: readonly DrawingElement[],
  appState: Readonly<Record<string, unknown>>,
  files: DrawingBinaryFiles,
): DrawingScene {
  const live = elements.filter((element) => element.isDeleted !== true);
  const used = new Set<string>();
  for (const element of live) {
    if (element.type === "image" && typeof element.fileId === "string") used.add(element.fileId);
  }
  const kept: DrawingBinaryFiles = {};
  for (const [id, file] of Object.entries(files)) if (used.has(id)) kept[id] = file;
  return {
    type: "excalidraw",
    version: 2,
    elements: live,
    appState: fileAppState(appState),
    files: kept,
  };
}

/**
 * A number that grows with every edit: Excalidraw bumps an element's `version` on each change and
 * deletes by marking (with a bump), so a sum over elements and the view settings tells edits from
 * mere re-renders.
 */
export function editKey(
  elements: readonly DrawingElement[],
  appState: Readonly<Record<string, unknown>>,
): string {
  let sum = 0;
  for (const element of elements) sum += typeof element.version === "number" ? element.version : 0;
  return `${elements.length}:${sum}:${JSON.stringify(fileAppState(appState))}`;
}
