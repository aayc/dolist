import type { Services } from "../app/services";
import { dailyDateOf } from "../features/daily/daily-nav";
import { resolveTheme } from "../features/settings/theme";
import { useAgentStore } from "../state/agent-store";
import { getSettings } from "../state/settings-store";
import { useTabsStore } from "../state/tabs-store";
import { type Overlay, ui } from "../state/ui-store";
import { parseHotkey } from "./hotkeys";
import type { Command, CommandContext } from "./registry";

function eventStart(context: CommandContext): number | undefined {
  return context.event?.timeStamp;
}

function activeNote(): string | null {
  return useTabsStore.getState().active;
}

function hasActiveNote(): boolean {
  return activeNote() !== null;
}

function toggleOverlay(kind: "palette" | "switcher"): void {
  const current = ui.get().overlay;
  if (current?.kind === kind) ui.closeOverlay();
  else ui.openOverlay({ kind } as Overlay);
}

export function createDefaultCommands(services: Services): Command[] {
  const { workspace, agent } = services;
  const hk = parseHotkey;
  return [
    {
      id: "daily:today",
      name: "Open today's daily note",
      hotkeys: [hk("Mod+Shift+D")],
      run: (ctx) => workspace.openToday(eventStart(ctx)),
    },
    {
      id: "daily:previous",
      name: "Open previous daily note",
      hotkeys: [hk("Mod+Shift+P")],
      run: (ctx) => void workspace.openAdjacentDaily(-1, eventStart(ctx)),
    },
    {
      id: "daily:next",
      name: "Open next daily note",
      hotkeys: [hk("Mod+Shift+N")],
      run: (ctx) => void workspace.openAdjacentDaily(1, eventStart(ctx)),
    },
    {
      id: "daily:tomorrow",
      name: "Open tomorrow's daily note",
      run: () => workspace.openTomorrow(),
    },
    {
      id: "palette:open",
      name: "Open command palette",
      hotkeys: [hk("Mod+P")],
      run: () => toggleOverlay("palette"),
    },
    {
      id: "switcher:open",
      name: "Open quick switcher",
      hotkeys: [hk("Mod+O")],
      run: () => toggleOverlay("switcher"),
    },
    {
      id: "note:new",
      name: "Create new note",
      hotkeys: [hk("Mod+N")],
      run: () => void workspace.createNote(),
    },
    {
      id: "folder:new",
      name: "Create new folder",
      run: () => void workspace.createFolder(),
    },
    {
      id: "settings:open",
      name: "Open settings",
      hotkeys: [hk("Mod+,")],
      run: () => ui.openOverlay({ kind: "settings", section: "general" }),
    },
    {
      id: "search:open",
      name: "Search vault",
      hotkeys: [hk("Mod+Shift+F")],
      run: () => ui.focusSearch(),
    },
    {
      id: "panel:right",
      name: "Toggle agent panel",
      hotkeys: [hk("Mod+\\")],
      run: () => ui.toggleRight(),
    },
    {
      id: "panel:left",
      name: "Toggle file explorer",
      run: () => ui.toggleLeft("files"),
    },
    {
      id: "agent:inbox",
      name: "Open agent inbox",
      hotkeys: [hk("Mod+Shift+A")],
      run: () => ui.toggleInbox(),
    },
    {
      id: "agent:toggle",
      name: "Toggle agent on/off",
      run: () => agent.setEnabled(!(useAgentStore.getState().status?.enabled ?? true)),
    },
    {
      id: "tab:close",
      name: "Close current tab",
      hotkeys: [hk("Mod+W")],
      when: hasActiveNote,
      run: () => workspace.closeActiveTab(),
    },
    {
      id: "note:save",
      name: "Save current note",
      hotkeys: [hk("Mod+S")],
      when: hasActiveNote,
      run: () => {
        const path = activeNote();
        if (path) void workspace.notes.flush(path);
      },
    },
    {
      id: "note:rename",
      name: "Rename current note",
      when: hasActiveNote,
      run: () => {
        const path = activeNote();
        if (!path) return;
        if (dailyDateOf(path, getSettings().dailyNotes)) ui.renameInExplorer(path);
        else ui.focusTitle(path);
      },
    },
    {
      id: "note:delete",
      name: "Delete current note",
      when: hasActiveNote,
      run: () => {
        const path = activeNote();
        if (path) workspace.requestDelete(path);
      },
    },
    {
      id: "note:reveal",
      name: "Reveal current note in file explorer",
      when: hasActiveNote,
      run: () => ui.showLeft("files"),
    },
    {
      id: "theme:toggle",
      name: "Toggle light/dark theme",
      run: () => {
        const current = resolveTheme(getSettings().theme);
        void services.updateSettings({ theme: current === "dark" ? "light" : "dark" });
      },
    },
    {
      id: "editor:vim",
      name: "Toggle Vim mode",
      run: () =>
        void services.updateSettings({ editor: { vimMode: !getSettings().editor.vimMode } }),
    },
    {
      id: "editor:live-preview",
      name: "Toggle live preview",
      run: () =>
        void services.updateSettings({
          editor: { livePreview: !getSettings().editor.livePreview },
        }),
    },
    {
      id: "editor:line-numbers",
      name: "Toggle line numbers",
      run: () =>
        void services.updateSettings({
          editor: { showLineNumbers: !getSettings().editor.showLineNumbers },
        }),
    },
    {
      id: "overlay:close",
      name: "Close overlay",
      hidden: true,
      hotkeys: [hk("Escape")],
      when: () => ui.get().overlay !== null,
      run: () => ui.closeOverlay(),
    },
  ];
}
