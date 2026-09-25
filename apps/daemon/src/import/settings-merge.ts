/**
 * The new vault's `settings.json`: the current vault's file as it is (agent settings, theme,
 * weekly notes, the always-on machine, keys from newer apps), with the new vault's daily-note
 * settings and the editor settings Obsidian has (vim mode, vimrc, live preview, …). Obsidian's
 * theme applies only when this vault never chose one. A file written by a newer app is copied
 * unchanged, since this version can't tell what its keys mean.
 */
import { join } from "node:path";
import {
  decodePersistedSettings,
  encodePersistedSettings,
  isPersistedObject,
  PERSISTED_PATHS,
  type PersistedSettingsDocument,
} from "@ddl/contract";
import type { AppSettings, DailyNoteSettings, DeepPartial } from "@ddl/core";
import { readRegularFile } from "./files";

const MAX_SETTINGS_BYTES = 1024 * 1024;

export const SETTINGS_PATH = PERSISTED_PATHS.settings;

export type MergedSettings = { kind: "merged"; text: string } | { kind: "newer"; absolute: string };

export async function mergeSettingsFile(
  vault: string | null,
  dailyNotes: DailyNoteSettings,
  obsidian: DeepPartial<AppSettings>,
): Promise<MergedSettings> {
  let document: PersistedSettingsDocument = {};
  if (vault) {
    const absolute = join(vault, SETTINGS_PATH);
    const bytes = await readRegularFile(absolute, MAX_SETTINGS_BYTES);
    const decoded = bytes ? decodePersistedSettings(bytes.toString("utf8")) : null;
    if (decoded?.ok) document = decoded.value;
    else if (decoded?.kind === "newer") return { kind: "newer", absolute };
  }
  const editor = isPersistedObject(document.editor) ? document.editor : {};
  const merged: PersistedSettingsDocument = {
    ...document,
    dailyNotes: { ...dailyNotes },
    editor: { ...editor, ...obsidian.editor },
  };
  if (document.theme === undefined && obsidian.theme) merged.theme = obsidian.theme;
  return { kind: "merged", text: encodePersistedSettings(merged) };
}
