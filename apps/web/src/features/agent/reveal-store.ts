import { create } from "zustand";

interface RevealState {
  /** threadId → messages of that thread typing out on screen right now. */
  revealing: Readonly<Record<string, number>>;
}

/** Which threads have text typing out: the activity row stays quiet meanwhile (the caret says it). */
export const useRevealStore = create<RevealState>(() => ({ revealing: {} }));

export function markRevealing(threadId: string, revealing: boolean): void {
  useRevealStore.setState((state) => {
    const count = Math.max(0, (state.revealing[threadId] ?? 0) + (revealing ? 1 : -1));
    const { [threadId]: _previous, ...rest } = state.revealing;
    return { revealing: count > 0 ? { ...rest, [threadId]: count } : rest };
  });
}
