import { DEFAULT_SETTINGS, mergeSettings } from "@ddl/core";
import { MemoryStorageProvider } from "@ddl/storage";
import { describe, expect, it } from "vitest";
import { SettingsValidationError } from "./settings-schema";
import { createSettingsStore, SETTINGS_PATH } from "./settings-store";

async function storedOverrides(storage: MemoryStorageProvider): Promise<unknown> {
  const file = await storage.read(SETTINGS_PATH);
  return file ? JSON.parse(file.content) : null;
}

describe("settings store", () => {
  it("starts from defaults and persists only explicit overrides", async () => {
    const storage = new MemoryStorageProvider();
    const store = await createSettingsStore({ storage });
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
    const storage = new MemoryStorageProvider({
      initialFiles: { [SETTINGS_PATH]: JSON.stringify({ theme: "dark" }) },
    });
    const defaults = mergeSettings(DEFAULT_SETTINGS, { agent: { model: "vendor/model-from-env" } });
    const store = await createSettingsStore({ storage, defaults });
    expect(store.get().theme).toBe("dark");
    expect(store.get().agent.model).toBe("vendor/model-from-env");
  });

  it("notifies listeners after persisting", async () => {
    const storage = new MemoryStorageProvider();
    const store = await createSettingsStore({ storage });
    const seen: string[] = [];
    store.onChange((settings) => seen.push(settings.theme));
    await store.update({ theme: "light" });
    expect(seen).toEqual(["light"]);
  });

  it("rejects settings that would put notes outside the vault or in hidden folders", async () => {
    const storage = new MemoryStorageProvider();
    const store = await createSettingsStore({ storage });
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

  it("serializes concurrent updates without losing either", async () => {
    const storage = new MemoryStorageProvider();
    const store = await createSettingsStore({ storage });
    await Promise.all([
      store.update({ theme: "dark" }),
      store.update({ editor: { fontSize: 20 } }),
    ]);
    expect(store.get()).toMatchObject({ theme: "dark", editor: { fontSize: 20 } });
    expect(await storedOverrides(storage)).toEqual({ theme: "dark", editor: { fontSize: 20 } });
  });

  it("drops invalid sections of a hand-edited file and survives invalid JSON", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: {
        [SETTINGS_PATH]: JSON.stringify({ theme: "neon", editor: { vimMode: true }, bogus: 1 }),
      },
    });
    const store = await createSettingsStore({ storage });
    expect(store.get().theme).toBe(DEFAULT_SETTINGS.theme);
    expect(store.get().editor.vimMode).toBe(true);

    const corrupt = new MemoryStorageProvider({ initialFiles: { [SETTINGS_PATH]: "{not json" } });
    const fallback = await createSettingsStore({ storage: corrupt });
    expect(fallback.get()).toEqual(DEFAULT_SETTINGS);
    expect((await corrupt.read(SETTINGS_PATH))?.content).toBe("{not json");
  });
});

describe("Obsidian import on first run", () => {
  it("imports daily notes, editor preferences and theme", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: {
        ".obsidian/daily-notes.json": JSON.stringify({
          folder: "Journal/Daily/",
          format: "YYYY/MM/YYYY-MM-DD",
          template: "Templates/Daily Template",
          autorun: true,
        }),
        ".obsidian/app.json": JSON.stringify({ vimMode: true, showLineNumber: true, legacy: 1 }),
        ".obsidian/appearance.json": JSON.stringify({ theme: "moonstone" }),
      },
    });
    const store = await createSettingsStore({ storage });
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
    const storage = new MemoryStorageProvider({
      initialFiles: { ".obsidian/daily-notes.json": JSON.stringify({ template: "tpl" }) },
    });
    const store = await createSettingsStore({ storage });
    expect(store.get().dailyNotes).toEqual({ folder: "", format: "YYYY-MM-DD", template: "tpl" });
  });

  it("does not import again once settings exist", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: {
        [SETTINGS_PATH]: "{}",
        ".obsidian/app.json": JSON.stringify({ vimMode: true }),
      },
    });
    const store = await createSettingsStore({ storage });
    expect(store.get().editor.vimMode).toBe(false);
  });

  it("ignores unreadable Obsidian config", async () => {
    const storage = new MemoryStorageProvider({
      initialFiles: {
        ".obsidian/daily-notes.json": "{broken",
        ".obsidian/app.json": JSON.stringify({ vimMode: "yes" }),
      },
    });
    const store = await createSettingsStore({ storage });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });
});
