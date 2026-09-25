import type { RoutineNotify, RoutineUse } from "@ddl/core";
import { create } from "zustand";
import { readJson, STORAGE_KEYS, writeJson } from "../lib/storage";

export type LeftView = "files" | "search";
export type ThreadTab = "chat" | "artifacts" | "browser" | "computer";
export type SettingsSection =
  | "general"
  | "editor"
  | "daily"
  | "agent"
  | "location"
  | "machine"
  | "sync"
  | "devices"
  | "remote"
  | "computer"
  | "connectors"
  | "about";

export type RightView =
  | { kind: "inbox" }
  | { kind: "thread"; threadId: string }
  /** Badge clicked before the orchestrator created a thread; resolves once it exists. */
  | { kind: "task"; taskId: string }
  /** Every routine. */
  | { kind: "routines" }
  /** One routine and its own inbox of runs. */
  | { kind: "routine"; routineId: string };

/** What the "New routine" dialog starts from (a finished task, for "Repeat this"). */
export interface RoutineDraft {
  name?: string;
  schedule?: string;
  instructions?: string;
  notify?: RoutineNotify;
  uses?: RoutineUse[];
  /** From "Repeat this": the task's thread. The user still gives the schedule. */
  fromThreadId?: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
}

export type Overlay =
  | { kind: "palette" }
  | { kind: "switcher" }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "artifact"; threadId: string; artifactId: string }
  | { kind: "confirm"; request: ConfirmRequest }
  | { kind: "new-routine"; draft?: RoutineDraft };

export interface UiState {
  leftOpen: boolean;
  leftWidth: number;
  leftView: LeftView;
  rightOpen: boolean;
  rightWidth: number;
  rightView: RightView;
  threadTab: ThreadTab;
  overlay: Overlay | null;
  expanded: Readonly<Record<string, true>>;
  /** Explorer item currently being renamed inline. */
  renaming: string | null;
  /** Bumped to ask the search view to take focus. */
  searchFocus: number;
  /** Note whose inline title should take focus (and select its text) once shown. */
  titleFocus: string | null;
  /** A message the orchestrator's chat should scroll to and flash once it shows it. */
  chatFocus: { messageId: string; at: number } | null;
}

interface PersistedLayout {
  leftOpen: boolean;
  leftWidth: number;
  leftView: LeftView;
  rightOpen: boolean;
  rightWidth: number;
  expanded: Record<string, true>;
}

export const LEFT_WIDTH = { min: 180, max: 520, initial: 260 };
export const RIGHT_WIDTH = { min: 300, max: 720, initial: 380 };

const persisted = readJson<Partial<PersistedLayout>>(STORAGE_KEYS.layout) ?? {};

export const useUiStore = create<UiState>(() => ({
  leftOpen: persisted.leftOpen ?? true,
  leftWidth: persisted.leftWidth ?? LEFT_WIDTH.initial,
  leftView: persisted.leftView ?? "files",
  rightOpen: persisted.rightOpen ?? false,
  rightWidth: persisted.rightWidth ?? RIGHT_WIDTH.initial,
  rightView: { kind: "inbox" },
  threadTab: "chat",
  overlay: null,
  expanded: persisted.expanded ?? { Daily: true },
  renaming: null,
  searchFocus: 0,
  titleFocus: null,
  chatFocus: null,
}));

let persistTimer: ReturnType<typeof setTimeout> | undefined;
useUiStore.subscribe((state, previous) => {
  if (
    state.leftOpen === previous.leftOpen &&
    state.leftWidth === previous.leftWidth &&
    state.leftView === previous.leftView &&
    state.rightOpen === previous.rightOpen &&
    state.rightWidth === previous.rightWidth &&
    state.expanded === previous.expanded
  ) {
    return;
  }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const s = useUiStore.getState();
    writeJson(STORAGE_KEYS.layout, {
      leftOpen: s.leftOpen,
      leftWidth: s.leftWidth,
      leftView: s.leftView,
      rightOpen: s.rightOpen,
      rightWidth: s.rightWidth,
      expanded: s.expanded,
    } satisfies PersistedLayout);
  }, 250);
});

/** Dialogs open on top of the overlay (a confirmation inside settings), innermost last. */
const stackedDialogs: Array<() => void> = [];

export const ui = {
  set: useUiStore.setState,
  get: useUiStore.getState,

  openOverlay(overlay: Overlay): void {
    useUiStore.setState({ overlay });
  },

  /** Closes the innermost dialog stacked on the overlay, else the overlay itself (Escape). */
  closeOverlay(): void {
    const stacked = stackedDialogs.at(-1);
    if (stacked) stacked();
    else if (useUiStore.getState().overlay) useUiStore.setState({ overlay: null });
  },

  /** Registers a dialog shown on top of the overlay; returns its unregister. */
  stackDialog(close: () => void): () => void {
    stackedDialogs.push(close);
    return () => {
      const index = stackedDialogs.lastIndexOf(close);
      if (index !== -1) stackedDialogs.splice(index, 1);
    };
  },

  confirm(request: ConfirmRequest): void {
    useUiStore.setState({ overlay: { kind: "confirm", request } });
  },

  toggleLeft(view?: LeftView): void {
    const s = useUiStore.getState();
    if (view && s.leftOpen && s.leftView !== view) useUiStore.setState({ leftView: view });
    else useUiStore.setState({ leftOpen: !s.leftOpen, ...(view ? { leftView: view } : {}) });
  },

  showLeft(view: LeftView): void {
    useUiStore.setState({ leftOpen: true, leftView: view });
  },

  toggleRight(): void {
    useUiStore.setState((s) => ({ rightOpen: !s.rightOpen }));
  },

  showInbox(): void {
    useUiStore.setState({ rightOpen: true, rightView: { kind: "inbox" } });
  },

  toggleInbox(): void {
    const s = useUiStore.getState();
    if (s.rightOpen && s.rightView.kind === "inbox") useUiStore.setState({ rightOpen: false });
    else useUiStore.setState({ rightOpen: true, rightView: { kind: "inbox" } });
  },

  showThread(threadId: string, tab: ThreadTab = "chat"): void {
    useUiStore.setState({
      rightOpen: true,
      rightView: { kind: "thread", threadId },
      threadTab: tab,
    });
  },

  showTask(taskId: string): void {
    useUiStore.setState({
      rightOpen: true,
      rightView: { kind: "task", taskId },
      threadTab: "chat",
    });
  },

  showRoutines(): void {
    useUiStore.setState({ rightOpen: true, rightView: { kind: "routines" } });
  },

  /** The ribbon's Routines button: closes the panel when routines are already what it shows. */
  toggleRoutines(): void {
    const { rightOpen, rightView } = useUiStore.getState();
    if (rightOpen && (rightView.kind === "routines" || rightView.kind === "routine")) {
      useUiStore.setState({ rightOpen: false });
    } else {
      ui.showRoutines();
    }
  },

  showRoutine(routineId: string): void {
    useUiStore.setState({ rightOpen: true, rightView: { kind: "routine", routineId } });
  },

  newRoutine(draft?: RoutineDraft): void {
    useUiStore.setState({ overlay: { kind: "new-routine", ...(draft ? { draft } : {}) } });
  },

  setExpanded(path: string, expanded: boolean): void {
    const current = useUiStore.getState().expanded;
    if (Boolean(current[path]) === expanded) return;
    const next = { ...current };
    if (expanded) next[path] = true;
    else delete next[path];
    useUiStore.setState({ expanded: next });
  },

  expandAll(paths: readonly string[]): void {
    const current = useUiStore.getState().expanded;
    if (paths.every((p) => current[p])) return;
    const next = { ...current };
    for (const p of paths) next[p] = true;
    useUiStore.setState({ expanded: next });
  },

  focusSearch(): void {
    useUiStore.setState((s) => ({
      leftOpen: true,
      leftView: "search",
      searchFocus: s.searchFocus + 1,
    }));
  },

  focusTitle(path: string): void {
    useUiStore.setState({ titleFocus: path });
  },

  /** Inline rename in the file explorer, with the file revealed (daily notes have no title field). */
  renameInExplorer(path: string): void {
    const folders = path.split("/").slice(0, -1);
    ui.expandAll(folders.map((_, i) => folders.slice(0, i + 1).join("/")));
    useUiStore.setState({ leftOpen: true, leftView: "files", renaming: path });
  },
};
