import { preloadable } from "../lib/preloadable";

/**
 * Secondary UI lives in separate chunks (kept off the startup path) and is prefetched when the
 * main thread is idle, so the first open is still instant.
 */
export const AgentPanel = preloadable(() =>
  import("../features/agent/AgentPanel").then((m) => m.AgentPanel),
);
export const ArtifactViewer = preloadable(() =>
  import("../features/agent/ArtifactViewer").then((m) => m.ArtifactViewer),
);
export const CommandPalette = preloadable(() =>
  import("../features/palette/CommandPalette").then((m) => m.CommandPalette),
);
export const QuickSwitcher = preloadable(() =>
  import("../features/switcher/QuickSwitcher").then((m) => m.QuickSwitcher),
);
export const SettingsModal = preloadable(() =>
  import("../features/settings/SettingsModal").then((m) => m.SettingsModal),
);
export const SearchView = preloadable(() =>
  import("../features/search/SearchView").then((m) => m.SearchView),
);

export async function prefetchLazyChunks(): Promise<void> {
  await Promise.allSettled([
    AgentPanel.preload(),
    CommandPalette.preload(),
    QuickSwitcher.preload(),
    SearchView.preload(),
    SettingsModal.preload(),
    ArtifactViewer.preload(),
  ]);
}
