import {
  type AppSettings,
  DEFAULT_SETTINGS,
  type DeepPartial,
  Emitter,
  type Logger,
  mergeSettings,
  SIDECAR_DIR,
  silentLogger,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { readObsidianSettings } from "./obsidian-import";
import {
  SettingsValidationError,
  sanitizeStoredSettings,
  settingsProblems,
} from "./settings-schema";

export const SETTINGS_PATH = `${SIDECAR_DIR}/settings.json`;

export interface SettingsStore {
  get(): AppSettings;
  /** Validates, merges and persists a partial update; rejects with SettingsValidationError. */
  update(patch: DeepPartial<AppSettings>): Promise<AppSettings>;
  onChange(listener: (settings: AppSettings) => void): Unsubscribe;
}

export interface SettingsStoreOptions {
  storage: StorageProvider;
  /** What the vault's overrides merge over: DEFAULT_SETTINGS plus daemon config (e.g. DDL_MODEL). */
  defaults?: AppSettings;
  logger?: Logger;
}

/**
 * AppSettings live in the vault sidecar so they travel with the vault. The file holds only the
 * user's explicit overrides; effective settings are those merged over `defaults`. On first run the
 * overrides are seeded from the vault's Obsidian config.
 */
export async function createSettingsStore(options: SettingsStoreOptions): Promise<SettingsStore> {
  const { storage } = options;
  const defaults = options.defaults ?? DEFAULT_SETTINGS;
  const logger = options.logger ?? silentLogger;

  let overrides = await loadOverrides(storage, logger);
  if (overrides === null) {
    overrides = await readObsidianSettings(storage, logger);
    try {
      await writeOverrides(storage, overrides);
    } catch (error) {
      logger.warn("Could not save initial settings", { error: errorMessage(error) });
    }
  }
  let current = mergeSettings(defaults, overrides);
  const initialProblems = settingsProblems(current);
  if (initialProblems.length > 0) {
    logger.warn("Stored settings have problems", { problems: initialProblems });
  }

  const events = new Emitter<{ change: AppSettings }>();
  let queue: Promise<unknown> = Promise.resolve();

  return {
    get: () => current,
    onChange: (listener) => events.on("change", listener),
    update(patch) {
      const run = queue.then(async () => {
        const nextOverrides = mergePatch(overrides ?? {}, patch);
        const next = mergeSettings(defaults, nextOverrides);
        const problems = settingsProblems(next);
        if (problems.length > 0) throw new SettingsValidationError(problems.join("; "));
        await writeOverrides(storage, nextOverrides);
        overrides = nextOverrides;
        current = next;
        events.emit("change", next);
        return next;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

async function loadOverrides(
  storage: StorageProvider,
  logger: Logger,
): Promise<DeepPartial<AppSettings> | null> {
  const file = await storage.read(SETTINGS_PATH);
  if (!file) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(file.content);
  } catch {
    logger.error("Settings file is not valid JSON; using defaults until settings are saved again", {
      path: SETTINGS_PATH,
    });
    return {};
  }
  const { settings, dropped } = sanitizeStoredSettings(raw);
  if (dropped.length > 0) {
    logger.warn("Ignoring invalid settings sections", { path: SETTINGS_PATH, sections: dropped });
  }
  return settings;
}

async function writeOverrides(
  storage: StorageProvider,
  overrides: DeepPartial<AppSettings>,
): Promise<void> {
  await storage.write(SETTINGS_PATH, `${JSON.stringify(overrides, null, 2)}\n`);
}

/** Deep merge for override objects: unlike `mergeSettings`, keys absent from `base` are added. */
function mergePatch<T extends object>(base: T, patch: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergePatch(current, value) : value;
  }
  return out as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
