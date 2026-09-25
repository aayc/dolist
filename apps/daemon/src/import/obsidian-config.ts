/**
 * What an Obsidian vault's config says: daily-note and editor settings (through the first-run
 * import, `readObsidianSettings`), enabled community plugins and the templates folder. Files are
 * read through `folderReader`, which never leaves the vault and caps what it reads.
 */
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  type AppSettings,
  type DailyNoteSettings,
  type DeepPartial,
  type Logger,
  type ObsidianEditorSettings,
  type ObsidianPlugin,
  type ObsidianSettingsFound,
  silentLogger,
} from "@ddl/core";
import { z } from "zod";
import {
  APP_FILE,
  APPEARANCE_FILE,
  cleanPath,
  DAILY_NOTES_FILE,
  OBSIDIAN_DAILY_FORMAT,
  readConfig,
  readObsidianSettings,
  type VaultReader,
  VIMRC_FILE,
} from "../obsidian-import";
import { readRegularFile } from "./files";
import { pluginSupport } from "./plugins";
import { isInside } from "./walk";

const CORE_PLUGINS_FILE = ".obsidian/core-plugins.json";
const COMMUNITY_PLUGINS_FILE = ".obsidian/community-plugins.json";
const TEMPLATES_FILE = ".obsidian/templates.json";
const TEMPLATER_FILE = ".obsidian/plugins/templater-obsidian/data.json";
/** Config files are small; anything bigger isn't one. */
const VAULT_READER_LIMIT = 1024 * 1024;
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_PLUGINS = 200;
const MAX_NAME = 200;

/** Obsidian's own defaults, for a vault with the Daily notes plugin on and no config file. */
const OBSIDIAN_DAILY_DEFAULTS: DailyNoteSettings = {
  folder: "",
  format: OBSIDIAN_DAILY_FORMAT,
  template: "",
};

export interface ObsidianConfig {
  isObsidianVault: boolean;
  settings: ObsidianSettingsFound;
  /** Whether `settings.dailyNotes` comes from a config file or Obsidian's defaults. */
  dailyNotesFrom: "file" | "defaults" | null;
  /** Everything to import into settings (the vimrc text included). */
  patch: DeepPartial<AppSettings>;
  plugins: ObsidianPlugin[];
  templatesFolder: string | null;
}

export async function readObsidianConfig(root: string, logger: Logger): Promise<ObsidianConfig> {
  const reader = folderReader(root);
  const exists = async (path: string) => (await reader.read(path)) !== null;
  const isObsidianVault = await realpath(join(root, ".obsidian"))
    .then((real) => isInside(real, root))
    .catch(() => false);
  const patch = await readObsidianSettings(reader, silentLogger);
  const files: string[] = [];
  for (const path of [DAILY_NOTES_FILE, APP_FILE, APPEARANCE_FILE, VIMRC_FILE]) {
    if (await exists(path)) files.push(path);
  }

  let dailyNotes: DailyNoteSettings | null = null;
  let dailyNotesFrom: ObsidianConfig["dailyNotesFrom"] = null;
  if (patch.dailyNotes) {
    dailyNotes = { ...OBSIDIAN_DAILY_DEFAULTS, ...patch.dailyNotes };
    dailyNotesFrom = "file";
  } else if (isObsidianVault && (await dailyNotesPluginOn(reader, logger))) {
    dailyNotes = { ...OBSIDIAN_DAILY_DEFAULTS };
    dailyNotesFrom = "defaults";
  }

  const { vimrc, ...editorPatch } = patch.editor ?? {};
  const editor: ObsidianEditorSettings = {};
  for (const key of [
    "vimMode",
    "livePreview",
    "readableLineLength",
    "showLineNumbers",
    "spellcheck",
  ] as const) {
    const value = editorPatch[key];
    if (typeof value === "boolean") editor[key] = value;
  }

  return {
    isObsidianVault,
    settings: {
      files,
      dailyNotes,
      editor,
      vimrc: typeof vimrc === "string",
      ...(patch.theme ? { theme: patch.theme } : {}),
    },
    dailyNotesFrom,
    patch,
    plugins: isObsidianVault ? await readPlugins(reader, logger) : [],
    templatesFolder: isObsidianVault ? await readTemplatesFolder(reader, logger) : null,
  };
}

/** Read-only view of a folder: regular files inside it only, at most `VAULT_READER_LIMIT` bytes. */
export function folderReader(root: string): VaultReader {
  return {
    async read(path) {
      const target = await realpath(join(root, path)).catch(() => null);
      if (!target || !isInside(target, root)) return null;
      const bytes = await readRegularFile(target, VAULT_READER_LIMIT);
      if (!bytes) return null;
      return { path, content: bytes.toString("utf8"), size: bytes.length, mtime: 0, version: "" };
    },
  };
}

const CorePluginsSchema = z.union([z.array(z.string()), z.record(z.string(), z.unknown())]);

/** Obsidian enables Daily notes in new vaults, so a missing list counts as on. */
async function dailyNotesPluginOn(reader: VaultReader, logger: Logger): Promise<boolean> {
  if (!(await reader.read(CORE_PLUGINS_FILE))) return true;
  const plugins = await readConfig(reader, CORE_PLUGINS_FILE, CorePluginsSchema, logger);
  if (!plugins) return true;
  return Array.isArray(plugins) ? plugins.includes("daily-notes") : plugins["daily-notes"] === true;
}

const ManifestSchema = z.looseObject({ name: z.string().optional() });

async function readPlugins(reader: VaultReader, logger: Logger): Promise<ObsidianPlugin[]> {
  const ids = await readConfig(reader, COMMUNITY_PLUGINS_FILE, z.array(z.unknown()), logger);
  if (!ids) return [];
  const unique = [
    ...new Set(ids.filter((id): id is string => typeof id === "string" && PLUGIN_ID.test(id))),
  ].slice(0, MAX_PLUGINS);
  const plugins: ObsidianPlugin[] = [];
  for (const id of unique) {
    const manifest = await readConfig(
      reader,
      `.obsidian/plugins/${id}/manifest.json`,
      ManifestSchema,
      silentLogger,
    );
    const name = manifest?.name
      ?.replace(/\p{Cc}/gu, "")
      .trim()
      .slice(0, MAX_NAME);
    plugins.push({ id, ...(name ? { name } : {}), ...pluginSupport(id) });
  }
  return plugins;
}

async function readTemplatesFolder(reader: VaultReader, logger: Logger): Promise<string | null> {
  const core = await readConfig(
    reader,
    TEMPLATES_FILE,
    z.looseObject({ folder: z.string().optional() }),
    silentLogger,
  );
  const templater = core?.folder
    ? null
    : await readConfig(
        reader,
        TEMPLATER_FILE,
        z.looseObject({ templates_folder: z.string().optional() }),
        silentLogger,
      );
  const folder = cleanPath(core?.folder ?? templater?.templates_folder, "templates", logger);
  return folder || null;
}
