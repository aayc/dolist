import type { ObsidianPluginSupport } from "@ddl/core";

export interface PluginSupportNote {
  support: ObsidianPluginSupport;
  note: string;
}

/**
 * How Obsidian community plugins fare here, by plugin id (the folder name under
 * `.obsidian/plugins/`). Add a row when a plugin comes up; every plugin's files are copied either
 * way, so it keeps working if the vault is opened in Obsidian again.
 */
export const PLUGIN_SUPPORT: Readonly<Record<string, PluginSupportNote>> = {
  dataview: { support: "partial", note: "Queries show as text." },
  "obsidian-excalidraw-plugin": { support: "supported", note: "Drawings open and edit here." },
  "templater-obsidian": {
    support: "partial",
    note: "Templates insert as plain text; Templater commands don't run.",
  },
  "obsidian-tasks-plugin": {
    support: "partial",
    note: "Task lines work; query blocks show as text.",
  },
  "obsidian-vimrc-support": {
    support: "supported",
    note: "The vimrc is imported with vim mode.",
  },
  "periodic-notes": {
    support: "partial",
    note: "Daily notes work; other periodic notes are plain notes.",
  },
  calendar: {
    support: "partial",
    note: "Daily notes work; move between them with the daily-note navigation.",
  },
  "obsidian-kanban": { support: "unsupported", note: "Boards show as their markdown lists." },
  "obsidian-outliner": {
    support: "partial",
    note: "Lists edit as plain markdown, without the outliner's commands.",
  },
  "table-editor-obsidian": {
    support: "partial",
    note: "Tables stay plain markdown, without the table editor.",
  },
  "obsidian-admonition": { support: "unsupported", note: "Admonition blocks show as code." },
  "obsidian-git": {
    support: "unsupported",
    note: "Doesn't run here; the vault is still a folder you can keep in git.",
  },
  "obsidian-style-settings": { support: "unsupported", note: "Theme settings don't apply here." },
  quickadd: { support: "unsupported", note: "Its commands don't run here." },
  omnisearch: { support: "unsupported", note: "Search here covers note names and contents." },
};

const UNKNOWN: PluginSupportNote = {
  support: "unknown",
  note: "Doesn't run here; its files are kept and it still works in Obsidian.",
};

export function pluginSupport(id: string): PluginSupportNote {
  return Object.hasOwn(PLUGIN_SUPPORT, id) ? PLUGIN_SUPPORT[id]! : UNKNOWN;
}
