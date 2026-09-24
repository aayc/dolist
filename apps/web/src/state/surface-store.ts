import type { SurfaceFrame, SurfaceKind } from "@ddl/core";
import { create } from "zustand";

export interface SurfaceAction {
  kind: string;
  x?: number;
  y?: number;
  text?: string;
  ts: number;
}

export interface SurfaceStoreState {
  frames: Readonly<Record<string, SurfaceFrame>>;
  actions: Readonly<Record<string, readonly SurfaceAction[]>>;
}

/** Separate store so high-frequency frames only wake the surface views. */
export const useSurfaceStore = create<SurfaceStoreState>(() => ({ frames: {}, actions: {} }));

export function surfaceKey(threadId: string, surface: SurfaceKind): string {
  return `${threadId}:${surface}`;
}

const MAX_ACTIONS = 40;

export function applySurfaceFrame(frame: SurfaceFrame): void {
  const key = surfaceKey(frame.threadId, frame.surface);
  useSurfaceStore.setState((state) => {
    const frames = { ...state.frames, [key]: frame };
    if (!frame.action) return { frames };
    const log = state.actions[key] ?? [];
    const last = log[log.length - 1];
    const action: SurfaceAction = { ...frame.action, ts: frame.ts };
    if (
      last &&
      last.kind === action.kind &&
      last.x === action.x &&
      last.y === action.y &&
      last.text === action.text
    ) {
      return { frames };
    }
    return { frames, actions: { ...state.actions, [key]: [...log, action].slice(-MAX_ACTIONS) } };
  });
}
