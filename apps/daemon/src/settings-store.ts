import {
  decodePersistedSettings,
  encodePersistedSettings,
  PERSISTED_PATHS,
  PersistedFile,
  type PersistedSettingsDocument,
  resolvePersistedSettings,
} from "@ddl/contract";
import {
  type AppSettings,
  DEFAULT_SETTINGS,
  type DeepPartial,
  Emitter,
  type Logger,
  mergeSettings,
  silentLogger,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { readObsidianSettings } from "./obsidian-import";
import { SettingsValidationError, settingsProblems } from "./settings-schema";

export const SETTINGS_PATH = PERSISTED_PATHS.settings;

export interface SettingsStore {
  get(): AppSettings;
  /** Validates, merges and persists a partial update; rejects with SettingsValidationError. */
  update(patch: DeepPartial<AppSettings>): Promise<AppSettings>;
  /**
   * Re-reads the file (sync brought another device's change) and emits `change` when the
   * effective settings differ. Resolves to the new settings, or null when nothing changed.
   */
  reload(): Promise<AppSettings | null>;
  onChange(listener: (settings: AppSettings) => void): Unsubscribe;
}

export interface SettingsStoreOptions {
  storage: StorageProvider;
  /** What the vault's overrides merge over: DEFAULT_SETTINGS plus daemon config (e.g. DDL_MODEL). */
  defaults?: AppSettings;
  logger?: Logger;
  now?: () => number;
}

/** Sections whose values combine into note paths, checked as a whole (see `settingsProblems`). */
const PATH_SECTIONS = ["dailyNotes", "weeklyNotes"] as const;

/**
 * AppSettings live in the vault sidecar (format in @ddl/contract) so they travel with the vault.
 * The file holds only the user's explicit overrides; effective settings are those merged over
 * `defaults`. It is patched in place: an update rewrites only the fields it changes, so settings
 * this version does not know (written by a newer app elsewhere) and values it cannot use survive.
 *
 * - Invalid stored values fall back to their defaults field by field; daily/weekly note settings
 *   that would put notes in a hidden folder or outside the vault fall back as a section.
 * - A corrupt file is moved to `.daily-do-list/corrupt/` and settings start over as on first run
 *   (seeded from the vault's Obsidian config).
 * - A file from a newer app is never overwritten: defaults apply and updates are refused.
 * - Updates re-read the file (conditional writes), so a change synced from another device while
 *   the daemon runs is kept, not clobbered; `reload()` applies such a change right away.
 */
export async function createSettingsStore(options: SettingsStoreOptions): Promise<SettingsStore> {
  const defaults = options.defaults ?? DEFAULT_SETTINGS;
  const logger = options.logger ?? silentLogger;
  const file = new PersistedFile({
    storage: options.storage,
    path: SETTINGS_PATH,
    decode: decodePersistedSettings,
    logger,
    ...(options.now ? { now: options.now } : {}),
  });

  let stored: PersistedSettingsDocument = {};
  let firstRun = false;
  try {
    const result = await file.load();
    if (result.status === "loaded") stored = result.value;
    else if (result.status === "newer") {
      logger.warn("Settings were saved by a newer version of the app; using defaults", {
        path: SETTINGS_PATH,
        version: result.version,
      });
    } else firstRun = result.status === "missing" || result.movedTo !== null;
  } catch (error) {
    logger.error("Could not read settings; using defaults until they can be read", {
      path: SETTINGS_PATH,
      error: errorMessage(error),
    });
  }

  if (firstRun) {
    stored = seedFrom(defaults, await readObsidianSettings(options.storage, logger));
    // Only what was imported: a device joining a synced vault would otherwise win the first sync
    // with an empty file (text conflicts keep this side) and reset every device's settings.
    if (Object.keys(stored).length > 0) {
      try {
        await file.save(() => encodePersistedSettings(stored));
      } catch (error) {
        logger.warn("Could not save initial settings", { error: errorMessage(error) });
      }
    }
  }

  const initial = resolveSettings(defaults, stored);
  if (initial.invalid.length > 0) {
    logger.warn("Ignoring invalid settings; their defaults apply", { fields: initial.invalid });
  }
  if (initial.fallback.length > 0) {
    logger.warn(
      "Ignoring note settings that would put notes outside the vault or in a hidden folder",
      {
        sections: initial.fallback,
      },
    );
  }
  if (initial.unknown.length > 0) {
    logger.info("Keeping settings this version does not know", { fields: initial.unknown });
  }
  let current = initial.settings;

  const events = new Emitter<{ change: AppSettings }>();
  let queue: Promise<unknown> = Promise.resolve();

  return {
    get: () => current,
    onChange: (listener) => events.on("change", listener),
    update(patch) {
      const run = queue.then(async () => {
        const check = resolvePersistedSettings(patch as PersistedSettingsDocument);
        const rejected = [...check.invalid, ...check.unknown];
        if (rejected.length > 0) {
          throw new SettingsValidationError(`Invalid settings: ${rejected.join(", ")}`);
        }
        let next = stored;
        const outcome = await file.save(
          () => {
            next = mergePatch(stored, patch as PersistedSettingsDocument);
            const problems = patchedPathProblems(defaults, next, patch);
            if (problems.length > 0) throw new SettingsValidationError(problems.join("; "));
            return encodePersistedSettings(next);
          },
          (theirs) => {
            stored = theirs;
          },
        );
        if (outcome === "blocked") {
          const reason = file.blocked ?? "is not writable";
          const hint = reason.includes("newer version")
            ? " Update the app to change settings."
            : "";
          throw new SettingsValidationError(
            `Settings can't be saved: ${SETTINGS_PATH} ${reason}.${hint}`,
          );
        }
        stored = next;
        current = resolveSettings(defaults, stored).settings;
        events.emit("change", current);
        return current;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    reload() {
      const run = queue.then(async () => {
        const result = await file.load();
        if (result.status !== "loaded") return null;
        stored = result.value;
        const next = resolveSettings(defaults, stored).settings;
        if (JSON.stringify(next) === JSON.stringify(current)) return null;
        current = next;
        events.emit("change", current);
        return current;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

interface ResolvedSettings {
  settings: AppSettings;
  /** Stored values that failed validation (dotted paths). */
  invalid: string[];
  /** Stored keys this version does not know. */
  unknown: string[];
  /** Note sections ignored because together they produce unusable paths. */
  fallback: string[];
}

function resolveSettings(
  defaults: AppSettings,
  stored: PersistedSettingsDocument,
): ResolvedSettings {
  const { overrides, invalid, unknown } = resolvePersistedSettings(stored);
  const { usable, fallback } = withoutUnusableSections(defaults, overrides);
  return { settings: mergeSettings(defaults, usable), invalid, unknown, fallback };
}

function withoutUnusableSections(
  defaults: AppSettings,
  overrides: DeepPartial<AppSettings>,
): { usable: DeepPartial<AppSettings>; fallback: string[] } {
  const usable: DeepPartial<AppSettings> = { ...overrides };
  const fallback: string[] = [];
  for (const section of PATH_SECTIONS) {
    if (usable[section] && sectionProblems(defaults, section, usable[section]).length > 0) {
      delete usable[section];
      fallback.push(section);
    }
  }
  return { usable, fallback };
}

/** Only sections the patch touches can reject it: a bad hand edit elsewhere must not block it. */
function patchedPathProblems(
  defaults: AppSettings,
  next: PersistedSettingsDocument,
  patch: DeepPartial<AppSettings>,
): string[] {
  const { overrides } = resolvePersistedSettings(next);
  return PATH_SECTIONS.flatMap((section) =>
    patch[section] ? sectionProblems(defaults, section, overrides[section] ?? {}) : [],
  );
}

function sectionProblems(
  defaults: AppSettings,
  section: (typeof PATH_SECTIONS)[number],
  value: DeepPartial<AppSettings>[typeof section],
): string[] {
  return settingsProblems(mergeSettings(defaults, { [section]: value }));
}

/** First-run overrides from the Obsidian import, keeping only values this app can use. */
function seedFrom(
  defaults: AppSettings,
  imported: DeepPartial<AppSettings>,
): PersistedSettingsDocument {
  const { overrides } = resolvePersistedSettings(imported as PersistedSettingsDocument);
  return withoutUnusableSections(defaults, overrides).usable as PersistedSettingsDocument;
}

/** Deep merge for override objects: unlike `mergeSettings`, keys absent from `base` are added. */
function mergePatch(
  base: PersistedSettingsDocument,
  patch: Readonly<Record<string, unknown>>,
): PersistedSettingsDocument {
  const out: PersistedSettingsDocument = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergePatch(current, value) : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
