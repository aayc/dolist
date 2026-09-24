import { create } from "zustand";

export type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

export interface NotesUiState {
  /** Save state per loaded note. Changes on transitions only, never per keystroke. */
  saveState: Readonly<Record<string, SaveState>>;
  /** Word count of the active note (debounced). */
  wordCount: number | null;
}

export const useNotesStore = create<NotesUiState>(() => ({ saveState: {}, wordCount: null }));

export function setSaveState(path: string, state: SaveState | null): void {
  const current = useNotesStore.getState().saveState;
  if ((current[path] ?? null) === state) return;
  const next = { ...current };
  if (state === null) delete next[path];
  else next[path] = state;
  useNotesStore.setState({ saveState: next });
}

export function setWordCount(count: number | null): void {
  if (useNotesStore.getState().wordCount !== count) useNotesStore.setState({ wordCount: count });
}
