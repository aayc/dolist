import { type AppSettings, DEFAULT_SETTINGS, type DeepPartial, mergeSettings } from "@ddl/core";
import { preloadVim } from "@ddl/editor";
import { create } from "zustand";
import { readJson, STORAGE_KEYS, writeJson } from "../lib/storage";

export interface SettingsState {
  settings: AppSettings;
  /** True once the daemon's settings arrived (before that: last cached copy or defaults). */
  loaded: boolean;
}

function cachedSettings(): AppSettings {
  return mergeSettings(
    DEFAULT_SETTINGS,
    readJson<DeepPartial<AppSettings>>(STORAGE_KEYS.settingsCache) ?? undefined,
  );
}

/** Vim is code-split; fetch it in parallel with startup instead of after the editor mounts. */
function warmUp(settings: AppSettings): AppSettings {
  if (settings.editor.vimMode) void preloadVim();
  return settings;
}

export const useSettingsStore = create<SettingsState>(() => ({
  settings: warmUp(cachedSettings()),
  loaded: false,
}));

export function getSettings(): AppSettings {
  return useSettingsStore.getState().settings;
}

export function applySettings(settings: AppSettings, loaded = true): void {
  useSettingsStore.setState({
    settings: warmUp(settings),
    loaded: loaded || useSettingsStore.getState().loaded,
  });
  writeJson(STORAGE_KEYS.settingsCache, settings);
}

export function patchSettingsLocally(patch: DeepPartial<AppSettings>): AppSettings {
  const next = warmUp(mergeSettings(getSettings(), patch));
  useSettingsStore.setState({ settings: next });
  writeJson(STORAGE_KEYS.settingsCache, next);
  return next;
}
