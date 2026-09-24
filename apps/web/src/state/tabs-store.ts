import { create } from "zustand";

export interface TabsState {
  tabs: readonly string[];
  active: string | null;
}

export const useTabsStore = create<TabsState>(() => ({ tabs: [], active: null }));

/**
 * Obsidian semantics: navigating replaces the active tab's note unless the note is already open
 * (then that tab is activated) or a new tab is requested (Mod-click, middle-click, Shift+Enter).
 */
export function placeInTabs(state: TabsState, path: string, newTab: boolean): TabsState {
  if (state.tabs.includes(path)) return { tabs: state.tabs, active: path };
  const tabs = [...state.tabs];
  const activeIndex = state.active === null ? -1 : tabs.indexOf(state.active);
  if (activeIndex === -1) tabs.push(path);
  else if (newTab) tabs.splice(activeIndex + 1, 0, path);
  else tabs[activeIndex] = path;
  return { tabs, active: path };
}

/** Removes a tab and picks the neighbour that should become active (right first, like browsers). */
export function removeFromTabs(state: TabsState, path: string): TabsState {
  const index = state.tabs.indexOf(path);
  if (index === -1) return state;
  const tabs = state.tabs.filter((p) => p !== path);
  if (state.active !== path) return { tabs, active: state.active };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, active: next };
}

export function renameInTabs(state: TabsState, from: string, to: string): TabsState {
  const rename = (p: string) =>
    p === from ? to : p.startsWith(`${from}/`) ? `${to}${p.slice(from.length)}` : p;
  return {
    tabs: state.tabs.map(rename),
    active: state.active === null ? null : rename(state.active),
  };
}
