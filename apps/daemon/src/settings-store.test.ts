import {
  decodePersistedSettings,
  PersistedSettingsFileSchema,
  persistedQuarantinePath,
  resolvePersistedSettings,
} from "@ddl/contract";
import { type AppSettings, DEFAULT_SETTINGS, type Logger, mergeSettings } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it, vi } from "vitest";
import { settingsOverridesArb } from "../../../packages/contract/test/persisted/arbitraries";
import { readFixture } from "../../../packages/contract/test/persisted/fixtures";
import { SettingsPatchSchema, SettingsValidationError } from "./settings-schema";
import { createSettingsStore, SETTINGS_PATH } from "./settings-store";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0, 0);
const QUARANTINED = persistedQuarantinePath(SETTINGS_PATH, new Date(NOW));

/** The persisted overrides without `version` (asserted separately). */
async function storedOverrides(storage: MemoryStorageProvider): Promise<unknown> {
  const file = await storage.read(SETTINGS_PATH);
  if (!file) return null;
  const { version, ...overrides } = JSON.parse(file.content);
  expect(version).toBe(1);
  return overrides;
}

function vault(files: Record<string, string> = {}) {
  return new MemoryStorageProvider({ initialFiles: files });
}

function recordingLogger() {
  const entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: (message, fields) =>
      entries.push({ level: "debug", message, ...(fields ? { fields } : {}) }),
    info: (message, fields) =>
      entries.push({ level: "info", message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) =>
      entries.push({ level: "warn", message, ...(fields ? { fields } : {}) }),
    error: (message, fields) =>
      entries.push({ level: "error", message, ...(fields ? { fields } : {}) }),
    child: () => logger,
  };
  return { logger, entries };
}

const open = (storage: MemoryStorageProvider, logger?: Logger, defaults?: AppSettings) =>
  createSettingsStore({
    storage,
    now: () => NOW,
    ...(logger ? { logger } : {}),
    ...(defaults ? { defaults } : {}),
  });

describe("settings store", () => {
  it("starts from defaults and persists only explicit overrides", async () => {
    const storage = vault();
    const store = await open(storage);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(await storedOverrides(storage)).toEqual({});

    const next = await store.update({
      editor: { fontSize: 18 },
      agent: { watch: { futureDays: 2 } },
    });
    expect(next.editor).toEqual({ ...DEFAULT_SETTINGS.editor, fontSize: 18 });
    expect(next.agent.watch).toEqual({ pastDays: 0, futureDays: 2 });
    expect(await storedOverrides(storage)).toEqual({
      editor: { fontSize: 18 },
      agent: { watch: { futureDays: 2 } },
    });

    await store.update({ editor: { vimMode: true } });
    expect(await storedOverrides(storage)).toEqual({
      editor: { fontSize: 18, vimMode: true },
      agent: { watch: { futureDays: 2 } },
    });
  });

  it("reloads persisted overrides over the provided defaults", async () => {
    const storage = vault({ [SETTINGS_PATH]: JSON.stringify({ theme: "dark" }) });
    const defaults = mergeSettings(DEFAULT_SETTINGS, { agent: { model: "vendor/model-from-env" } });
    const store = await open(storage, undefined, defaults);
    expect(store.get().theme).toBe("dark");
    expect(store.get().agent.model).toBe("vendor/model-from-env");
  });

  it("notifies listeners after persisting", async () => {
    const store = await open(vault());
    const seen: string[] = [];
    store.onChange((settings) => seen.push(settings.theme));
    await store.update({ theme: "light" });
    expect(seen).toEqual(["light"]);
  });

  it("rejects settings that would put notes outside the vault or in hidden folders", async () => {
    const store = await open(vault());
    await expect(store.update({ dailyNotes: { folder: ".secret" } })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    await expect(store.update({ dailyNotes: { folder: "../outside" } })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    await expect(
      store.update({ dailyNotes: { template: ".daily-do-list/state" } }),
    ).rejects.toBeInstanceOf(SettingsValidationError);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    await expect(store.update({ theme: "dark" })).resolves.toMatchObject({ theme: "dark" });
  });

  it("rejects out-of-range values and unknown keys even without the HTTP schema in front", async () => {
    const storage = vault();
    const store = await open(storage);
    await expect(store.update({ editor: { fontSize: 999 } })).rejects.toThrow("editor.fontSize");
    await expect(store.update({ bogus: true } as never)).rejects.toThrow("bogus");
    expect(await storedOverrides(storage)).toEqual({});
  });

  it("serializes concurrent updates without losing either", async () => {
    const storage = vault();
    const store = await open(storage);
    await Promise.all([
      store.update({ theme: "dark" }),
      store.update({ editor: { fontSize: 20 } }),
    ]);
    expect(store.get()).toMatchObject({ theme: "dark", editor: { fontSize: 20 } });
    expect(await storedOverrides(storage)).toEqual({ theme: "dark", editor: { fontSize: 20 } });
  });

  it("falls back per field for invalid stored values and keeps them in the file", async () => {
    const storage = vault({
      [SETTINGS_PATH]: JSON.stringify({
        theme: "neon",
        editor: { vimMode: true, fontSize: 2 },
        bogus: 1,
      }),
    });
    const store = await open(storage);
    expect(store.get().theme).toBe(DEFAULT_SETTINGS.theme);
    expect(store.get().editor).toEqual({ ...DEFAULT_SETTINGS.editor, vimMode: true });
    await store.update({ agent: { enabled: false } });
    expect(await storedOverrides(storage)).toEqual({
      theme: "neon",
      editor: { vimMode: true, fontSize: 2 },
      bogus: 1,
      agent: { enabled: false },
    });
  });

  it("a bad hand-edited note folder does not block unrelated updates (regression)", async () => {
    // Previously every update re-checked every section, so any change failed with
    // "notes would be created in a hidden folder" once the file held such a folder.
    const storage = vault({
      [SETTINGS_PATH]: JSON.stringify({ version: 1, dailyNotes: { folder: ".hidden" } }),
    });
    const store = await open(storage);
    expect(store.get().dailyNotes).toEqual(DEFAULT_SETTINGS.dailyNotes);
    await expect(store.update({ theme: "dark" })).resolves.toMatchObject({ theme: "dark" });
    await expect(store.update({ dailyNotes: { format: "YYYY" } })).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    await expect(store.update({ dailyNotes: { folder: "Journal" } })).resolves.toMatchObject({
      dailyNotes: { folder: "Journal" },
    });
  });

  it("starts with defaults when the file cannot be read, and merges it at the next update (regression)", async () => {
    // Previously a read error made createSettingsStore throw, which stopped the daemon from starting.
    const storage = vault({ [SETTINGS_PATH]: JSON.stringify({ version: 1, theme: "dark" }) });
    const read = vi.spyOn(storage, "read").mockRejectedValueOnce(new Error("EIO"));
    const { logger, entries } = recordingLogger();
    const store = await open(storage, logger);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(entries.some((e) => e.level === "error")).toBe(true);
    read.mockRestore();
    const next = await store.update({ editor: { vimMode: true } });
    expect(next).toMatchObject({ theme: "dark", editor: { vimMode: true } });
    expect(await storedOverrides(storage)).toEqual({ theme: "dark", editor: { vimMode: true } });
  });
});

describe("golden settings fixtures through the real settings store", () => {
  it("v1.json loads exactly and is not rewritten", async () => {
    const content = readFixture("settings", "v1.json");
    const storage = vault({ [SETTINGS_PATH]: content });
    const store = await open(storage);
    expect(store.get()).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "dark",
      editor: { ...DEFAULT_SETTINGS.editor, vimMode: true, fontSize: 18 },
      dailyNotes: {
        folder: "Journal/Daily",
        format: "YYYY/MM/YYYY-MM-DD",
        template: "Templates/Daily",
      },
      agent: {
        ...DEFAULT_SETTINGS.agent,
        settleMs: 4000,
        model: "vendor/model-a",
        watch: { pastDays: 0, futureDays: 2 },
      },
    });
    expect((await storage.read(SETTINGS_PATH))!.content).toBe(content);
  });

  it("v1-invalid-values.json falls back field by field, reports it, and keeps every stored key", async () => {
    const storage = vault({ [SETTINGS_PATH]: readFixture("settings", "v1-invalid-values.json") });
    const { logger, entries } = recordingLogger();
    const store = await open(storage, logger);
    expect(store.get()).toEqual({
      ...DEFAULT_SETTINGS,
      editor: { ...DEFAULT_SETTINGS.editor, vimMode: true },
      agent: { ...DEFAULT_SETTINGS.agent, enabled: false },
    });
    expect(entries.map((e) => [e.level, e.message, e.fields])).toEqual([
      [
        "warn",
        "Ignoring invalid settings; their defaults apply",
        { fields: ["theme", "editor.fontSize", "agent.maxConcurrentSubagents", "agent.watch"] },
      ],
      [
        "warn",
        "Ignoring note settings that would put notes outside the vault or in a hidden folder",
        { sections: ["dailyNotes"] },
      ],
      [
        "info",
        "Keeping settings this version does not know",
        { fields: ["editor.ligatures", "notifications"] },
      ],
    ]);
    await store.update({ theme: "light" });
    expect(await storedOverrides(storage)).toEqual({
      theme: "light",
      editor: { vimMode: true, fontSize: 999, ligatures: true },
      dailyNotes: { folder: ".secret", format: "YYYY-MM-DD" },
      agent: { enabled: false, maxConcurrentSubagents: 0, watch: "all of them" },
      notifications: { approvals: "push" },
    });
  });

  it("legacy-unversioned.json loads and gains `version` (keeping its keys) on the next update", async () => {
    const storage = vault({ [SETTINGS_PATH]: readFixture("settings", "legacy-unversioned.json") });
    const store = await open(storage);
    expect(store.get()).toEqual({
      ...DEFAULT_SETTINGS,
      theme: "light",
      editor: { ...DEFAULT_SETTINGS.editor, spellcheck: true },
    });
    await store.update({ editor: { fontSize: 14 } });
    expect(await storedOverrides(storage)).toEqual({
      theme: "light",
      editor: { spellcheck: true, fontSize: 14 },
    });
  });

  it.each(["corrupt-truncated.json", "corrupt-not-object.json"])(
    "%s is moved aside byte for byte and settings start over as on first run",
    async (name) => {
      const content = readFixture("settings", name);
      const storage = vault({
        [SETTINGS_PATH]: content,
        ".obsidian/app.json": JSON.stringify({ vimMode: true }),
      });
      const store = await open(storage);
      expect(store.get()).toEqual({
        ...DEFAULT_SETTINGS,
        editor: { ...DEFAULT_SETTINGS.editor, vimMode: true },
      });
      expect((await storage.read(QUARANTINED))!.content).toBe(content);
      expect(await storedOverrides(storage)).toEqual({ editor: { vimMode: true } });
    },
  );

  it("future-version.json is never overwritten: defaults apply and updates are refused", async () => {
    const future = readFixture("settings", "future-version.json");
    const storage = vault({ [SETTINGS_PATH]: future });
    const store = await open(storage);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    await expect(store.update({ theme: "dark" })).rejects.toThrow(/newer version/);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect((await storage.read(SETTINGS_PATH))!.content).toBe(future);
  });
});

describe("settings.json edge cases", () => {
  it("accepts a byte order mark", async () => {
    const store = await open(vault({ [SETTINGS_PATH]: '\uFEFF{"version":1,"theme":"dark"}' }));
    expect(store.get().theme).toBe("dark");
  });

  it("treats an empty file as corrupt", async () => {
    const storage = vault({ [SETTINGS_PATH]: "" });
    const store = await open(storage);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect((await storage.read(QUARANTINED))!.content).toBe("");
  });

  it("keeps a change another device synced while running instead of clobbering it", async () => {
    const storage = vault();
    const store = await open(storage);
    storage.simulateExternalChange(SETTINGS_PATH, JSON.stringify({ version: 1, theme: "dark" }));
    const next = await store.update({ editor: { fontSize: 20 } });
    expect(next).toMatchObject({ theme: "dark", editor: { fontSize: 20 } });
    expect(await storedOverrides(storage)).toEqual({ theme: "dark", editor: { fontSize: 20 } });
  });

  it("refuses updates once a newer app version replaced the file while running", async () => {
    const storage = vault();
    const store = await open(storage);
    storage.simulateExternalChange(SETTINGS_PATH, '{"version":3}');
    await expect(store.update({ theme: "dark" })).rejects.toBeInstanceOf(SettingsValidationError);
    expect((await storage.read(SETTINGS_PATH))!.content).toBe('{"version":3}');
  });
});

describe("persisted settings validation matches PUT /api/settings", () => {
  const cases: Array<[string, unknown[]]> = [
    ["theme", ["system", "light", "dark", "neon", 1, null]],
    ["editor.vimMode", [true, false, "yes", 1]],
    ["editor.fontSize", [8, 16.5, 48, 7, 49, "16"]],
    ["editor.showLineNumbers", [true, 0]],
    ["dailyNotes.folder", ["", "Journal", "x".repeat(512), "x".repeat(513), 1]],
    ["dailyNotes.format", ["YYYY", "x".repeat(128), "x".repeat(129)]],
    ["weeklyNotes.template", ["t", "x".repeat(512), "x".repeat(513)]],
    ["agent.enabled", [true, "true"]],
    ["agent.settleMs", [0, 120_000, -1, 120_001, 1.5]],
    ["agent.maxConcurrentSubagents", [1, 32, 0, 33, 2.5]],
    ["agent.model", ["vendor/model", "  padded  ", "", "   ", "x".repeat(201)]],
    ["agent.judgeModel", ["vendor/judge", ""]],
    ["agent.watch.pastDays", [0, 366, -1, 367, 1.5]],
    ["agent.watch.futureDays", [7, "7"]],
    ["agent.actOnExistingTasks", [false, null]],
    [
      "agent.approvalTimeoutMs",
      [60_000, 30 * 24 * 60 * 60 * 1000, 59_999, 30 * 24 * 60 * 60 * 1000 + 1],
    ],
  ];
  const nest = (path: string, value: unknown) =>
    path.split(".").reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<
      string,
      unknown
    >;

  it.each(cases)("%s: both accept and reject the same values", (path, values) => {
    for (const value of values) {
      const doc = nest(path, value);
      const persisted = resolvePersistedSettings(doc).invalid.length === 0;
      const wire = SettingsPatchSchema.safeParse(doc).success;
      expect({ path, value, persisted }).toEqual({ path, value, persisted: wire });
    }
  });
});

describe("settings writer", () => {
  test.prop([fc.array(settingsOverridesArb, { minLength: 1, maxLength: 4 })])(
    "always writes a schema-valid file that loads back to the same settings",
    async (patches) => {
      const storage = vault();
      const store = await open(storage);
      for (const patch of patches) {
        try {
          await store.update(patch);
        } catch (error) {
          expect(error).toBeInstanceOf(SettingsValidationError);
        }
      }
      const raw = JSON.parse((await storage.read(SETTINGS_PATH))!.content);
      expect(PersistedSettingsFileSchema.safeParse(raw).success).toBe(true);
      expect(decodePersistedSettings(JSON.stringify(raw))).toMatchObject({
        ok: true,
        fromVersion: 1,
      });
      const reloaded = await open(storage);
      expect(reloaded.get()).toEqual(store.get());
    },
  );
});

describe("Obsidian import on first run", () => {
  it("imports daily notes, editor preferences and theme", async () => {
    const storage = vault({
      ".obsidian/daily-notes.json": JSON.stringify({
        folder: "Journal/Daily/",
        format: "YYYY/MM/YYYY-MM-DD",
        template: "Templates/Daily Template",
        autorun: true,
      }),
      ".obsidian/app.json": JSON.stringify({ vimMode: true, showLineNumber: true, legacy: 1 }),
      ".obsidian/appearance.json": JSON.stringify({ theme: "moonstone" }),
    });
    const store = await open(storage);
    expect(store.get().dailyNotes).toEqual({
      folder: "Journal/Daily",
      format: "YYYY/MM/YYYY-MM-DD",
      template: "Templates/Daily Template",
    });
    expect(store.get().editor).toMatchObject({ vimMode: true, showLineNumbers: true });
    expect(store.get().theme).toBe("light");
    expect(await storedOverrides(storage)).toMatchObject({
      dailyNotes: { folder: "Journal/Daily" },
    });
  });

  it("uses Obsidian's defaults for keys missing from daily-notes.json", async () => {
    const storage = vault({ ".obsidian/daily-notes.json": JSON.stringify({ template: "tpl" }) });
    const store = await open(storage);
    expect(store.get().dailyNotes).toEqual({ folder: "", format: "YYYY-MM-DD", template: "tpl" });
  });

  it("does not import again once settings exist", async () => {
    const storage = vault({
      [SETTINGS_PATH]: "{}",
      ".obsidian/app.json": JSON.stringify({ vimMode: true }),
    });
    const store = await open(storage);
    expect(store.get().editor.vimMode).toBe(false);
  });

  it("ignores unreadable Obsidian config", async () => {
    const storage = vault({
      ".obsidian/daily-notes.json": "{broken",
      ".obsidian/app.json": JSON.stringify({ vimMode: "yes" }),
    });
    const store = await open(storage);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("reads Obsidian config saved with a byte order mark", async () => {
    const storage = vault({ ".obsidian/app.json": `\uFEFF${JSON.stringify({ vimMode: true })}` });
    const store = await open(storage);
    expect(store.get().editor.vimMode).toBe(true);
  });

  it("does not seed values this app cannot use", async () => {
    const storage = vault({
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "Daily", format: "Y".repeat(200) }),
    });
    const store = await open(storage);
    expect(store.get().dailyNotes).toEqual({
      ...DEFAULT_SETTINGS.dailyNotes,
      folder: "Daily",
      template: "",
    });
    expect(await storedOverrides(storage)).toEqual({
      dailyNotes: { folder: "Daily", template: "" },
    });
  });
});
