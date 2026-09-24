/**
 * `.daily-do-list/settings.json` — the user's explicit `AppSettings` overrides (a deep partial),
 * merged over the defaults by the daemon's settings store (apps/daemon/src/settings-store.ts).
 * Pretty-printed JSON with a trailing newline; users may edit it by hand.
 *
 * Unlike the agent's state files this one is patched in place: a write changes only the fields
 * being updated, so keys this version does not know (settings added by a newer app on another
 * device) and values it cannot use survive. Invalid values fall back to their defaults one field at
 * a time instead of invalidating the file.
 *
 * v1: the unversioned overrides object written before formats were versioned, plus `version: 1`.
 */
import { AGENT_HARNESS_KINDS } from "@ddl/core";
import { z } from "zod";
import {
  decodePersisted,
  isPersistedObject,
  type PersistedDecodeResult,
  type PersistedDocument,
  type PersistedFormatSpec,
} from "./common";

export const PERSISTED_SETTINGS_VERSION = 1;

const Bool = z.boolean();
const ModelId = z.string().trim().min(1).max(200);
const PeriodicNotes = z
  .object({
    folder: z.string().max(512),
    format: z.string().max(128),
    template: z.string().max(512),
  })
  .partial();

/** Every known setting with its valid range; each leaf is validated (and falls back) on its own. */
export const PersistedSettingsOverridesSchema = z
  .object({
    theme: z.enum(["system", "light", "dark"]),
    editor: z
      .object({
        vimMode: Bool,
        vimrc: z.string().max(16_384),
        livePreview: Bool,
        readableLineLength: Bool,
        fontSize: z.number().min(8).max(48),
        spellcheck: Bool,
        showLineNumbers: Bool,
      })
      .partial(),
    dailyNotes: PeriodicNotes,
    weeklyNotes: PeriodicNotes,
    agent: z
      .object({
        enabled: Bool,
        settleMs: z.int().min(0).max(120_000),
        maxConcurrentSubagents: z.int().min(1).max(32),
        harness: z.enum(AGENT_HARNESS_KINDS),
        model: ModelId,
        cursorModel: ModelId,
        judgeModel: ModelId,
        watch: z
          .object({ pastDays: z.int().min(0).max(366), futureDays: z.int().min(0).max(366) })
          .partial(),
        actOnExistingTasks: Bool,
        approvalTimeoutMs: z
          .int()
          .min(60_000)
          .max(30 * 24 * 60 * 60 * 1000),
      })
      .partial(),
  })
  .partial();
export type PersistedSettingsOverrides = z.infer<typeof PersistedSettingsOverridesSchema>;

/** A fully valid file; files on disk may also carry unknown keys and invalid values. */
export const PersistedSettingsFileSchema = PersistedSettingsOverridesSchema.extend({
  version: z.literal(PERSISTED_SETTINGS_VERSION),
});
export type PersistedSettingsFile = z.infer<typeof PersistedSettingsFileSchema>;

/** The file's content without `version`, exactly as stored (unknown keys and invalid values kept). */
export type PersistedSettingsDocument = PersistedDocument;

const settingsSpec: PersistedFormatSpec<PersistedSettingsDocument> = {
  version: PERSISTED_SETTINGS_VERSION,
  migrateUnversioned: (doc) => ({ ...doc, version: 1 }),
  read(doc) {
    const { version: _version, ...overrides } = doc;
    return overrides;
  },
};

export function decodePersistedSettings(
  text: string,
): PersistedDecodeResult<PersistedSettingsDocument> {
  return decodePersisted(settingsSpec, text);
}

export function encodePersistedSettings(document: PersistedSettingsDocument): string {
  const { version: _version, ...overrides } = document;
  return `${JSON.stringify({ version: PERSISTED_SETTINGS_VERSION, ...overrides }, null, 2)}\n`;
}

export interface PersistedSettingsResolution {
  /** The valid leaves only. */
  overrides: PersistedSettingsOverrides;
  /** Dotted paths of stored values that failed validation (their defaults apply). */
  invalid: string[];
  /** Dotted paths of keys this version does not know (left in the file untouched). */
  unknown: string[];
}

/** Splits a stored document into usable overrides and per-field problems. Never throws. */
export function resolvePersistedSettings(
  document: PersistedSettingsDocument,
): PersistedSettingsResolution {
  const invalid: string[] = [];
  const unknown: string[] = [];
  const { version: _version, ...rest } = document;
  const overrides = resolveObject(rest, PersistedSettingsOverridesSchema, "", invalid, unknown);
  return { overrides: overrides as PersistedSettingsOverrides, invalid, unknown };
}

function resolveObject(
  value: PersistedDocument,
  schema: z.ZodObject,
  prefix: string,
  invalid: string[],
  unknown: string[],
): PersistedDocument {
  const out: PersistedDocument = {};
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const declared = Object.hasOwn(schema.shape, key) ? schema.shape[key] : undefined;
    if (!declared) {
      unknown.push(path);
      continue;
    }
    const field = declared instanceof z.ZodOptional ? declared.unwrap() : declared;
    if (field instanceof z.ZodObject) {
      if (!isPersistedObject(child)) {
        invalid.push(path);
        continue;
      }
      const nested = resolveObject(child, field, path, invalid, unknown);
      if (Object.keys(nested).length > 0) out[key] = nested;
      continue;
    }
    const result = field.safeParse(child);
    if (result.success) out[key] = result.data;
    else invalid.push(path);
  }
  return out;
}
