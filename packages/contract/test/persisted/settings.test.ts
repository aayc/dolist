import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  decodePersistedSettings,
  encodePersistedSettings,
  PersistedSettingsFileSchema,
  resolvePersistedSettings,
} from "../../src/persisted";
import { settingsOverridesArb } from "./arbitraries";

describe("decodePersistedSettings", () => {
  it("returns the stored document without `version`, unknown keys included", () => {
    expect(decodePersistedSettings('{"version":1,"theme":"dark","future":{"x":1}}')).toEqual({
      ok: true,
      value: { theme: "dark", future: { x: 1 } },
      fromVersion: 1,
      issues: [],
    });
  });

  it("reads legacy unversioned overrides", () => {
    expect(decodePersistedSettings('{"editor":{"vimMode":true}}')).toEqual({
      ok: true,
      value: { editor: { vimMode: true } },
      fromVersion: null,
      issues: [],
    });
  });

  it.each([
    ["not JSON", "{theme: dark}"],
    ["an array", "[]"],
    ["empty", ""],
    ["a string version", '{"version":"1"}'],
  ])("treats a file that is %s as corrupt", (_label, text) => {
    expect(decodePersistedSettings(text)).toMatchObject({ ok: false, kind: "corrupt" });
  });

  it("reports a newer version", () => {
    expect(decodePersistedSettings('{"version":2,"theme":{"mode":"dark"}}')).toEqual({
      ok: false,
      kind: "newer",
      version: 2,
    });
  });
});

describe("resolvePersistedSettings", () => {
  it("falls back one field at a time and reports what it ignored", () => {
    expect(
      resolvePersistedSettings({
        theme: "neon",
        editor: { vimMode: true, fontSize: 999, ligatures: true },
        agent: { watch: { pastDays: 2, futureDays: -1 }, model: "  vendor/model  " },
        weeklyNotes: "weekly",
        notifications: { email: false },
      }),
    ).toEqual({
      overrides: {
        editor: { vimMode: true },
        agent: { watch: { pastDays: 2 }, model: "vendor/model" },
      },
      invalid: ["theme", "editor.fontSize", "agent.watch.futureDays", "weeklyNotes"],
      unknown: ["editor.ligatures", "notifications"],
    });
  });

  it("keeps the agent harness and Cursor model, trimmed, and drops a harness it doesn't know", () => {
    expect(
      resolvePersistedSettings({
        agent: { harness: "cursor", cursorModel: " gpt-5.5[reasoning=high] " },
      }),
    ).toEqual({
      overrides: { agent: { harness: "cursor", cursorModel: "gpt-5.5[reasoning=high]" } },
      invalid: [],
      unknown: [],
    });
    // A newer app may add harnesses: this one falls back to the default for the field only.
    expect(
      resolvePersistedSettings({
        agent: { harness: "claude", cursorModel: "  ", model: "vendor/m" },
      }),
    ).toEqual({
      overrides: { agent: { model: "vendor/m" } },
      invalid: ["agent.harness", "agent.cursorModel"],
      unknown: [],
    });
  });

  it("keeps a known approval policy and drops any other value, so the default applies", () => {
    expect(resolvePersistedSettings({ agent: { approvalPolicy: "run_everything" } })).toEqual({
      overrides: { agent: { approvalPolicy: "run_everything" } },
      invalid: [],
      unknown: [],
    });
    for (const approvalPolicy of ["never_ask", "RUN_EVERYTHING", "", 3, null, ["ask_risky"]]) {
      expect(resolvePersistedSettings({ agent: { approvalPolicy, settleMs: 100 } })).toEqual({
        overrides: { agent: { settleMs: 100 } },
        invalid: ["agent.approvalPolicy"],
        unknown: [],
      });
    }
  });

  it("keeps a valid always-on machine and drops an unusable one whole", () => {
    const machine = { name: "vm-name", url: "https://vm-name.tailnet-name.ts.net" };
    expect(resolvePersistedSettings({ remote: { alwaysOnMachine: machine } })).toEqual({
      overrides: { remote: { alwaysOnMachine: machine } },
      invalid: [],
      unknown: [],
    });
    expect(resolvePersistedSettings({ remote: { alwaysOnMachine: null } })).toEqual({
      overrides: { remote: { alwaysOnMachine: null } },
      invalid: [],
      unknown: [],
    });
    for (const alwaysOnMachine of [
      { ...machine, url: "http://vm-name.tailnet-name.ts.net" },
      { ...machine, name: "" },
      { name: "vm-name" },
      "https://vm-name.tailnet-name.ts.net",
    ]) {
      expect(resolvePersistedSettings({ remote: { alwaysOnMachine }, theme: "dark" })).toEqual({
        overrides: { theme: "dark" },
        invalid: ["remote.alwaysOnMachine"],
        unknown: [],
      });
    }
  });

  it("drops empty sections and ignores a stray version key", () => {
    expect(resolvePersistedSettings({ version: 1, editor: { fontSize: 2 } })).toEqual({
      overrides: {},
      invalid: ["editor.fontSize"],
      unknown: [],
    });
  });

  it("does not treat prototype keys as settings", () => {
    const doc = JSON.parse('{"__proto__":{"theme":"dark"},"constructor":{"x":1},"toString":1}');
    expect(resolvePersistedSettings(doc)).toEqual({
      overrides: {},
      invalid: [],
      unknown: ["__proto__", "constructor", "toString"],
    });
  });

  test.prop([settingsOverridesArb])("keeps every valid override exactly", (overrides) => {
    const cleaned = JSON.parse(JSON.stringify(overrides));
    const dropEmpty = (value: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(value).flatMap(([key, child]) => {
          if (typeof child !== "object" || child === null) return [[key, child]];
          const nested = dropEmpty(child as Record<string, unknown>);
          return Object.keys(nested).length > 0 ? [[key, nested]] : [];
        }),
      );
    expect(resolvePersistedSettings(cleaned)).toEqual({
      overrides: dropEmpty(cleaned),
      invalid: [],
      unknown: [],
    });
  });

  test.prop([fc.jsonValue()])("never throws on arbitrary documents", (value) => {
    const doc = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
    expect(() => resolvePersistedSettings(doc as Record<string, unknown>)).not.toThrow();
  });
});

describe("encodePersistedSettings", () => {
  test.prop([settingsOverridesArb])(
    "writes version 1 first and parses with the v1 schema",
    (overrides) => {
      const text = encodePersistedSettings(overrides);
      const parsed = JSON.parse(text);
      expect(Object.keys(parsed)[0]).toBe("version");
      expect(PersistedSettingsFileSchema.safeParse(parsed).success).toBe(true);
      expect(decodePersistedSettings(text)).toMatchObject({ ok: true, fromVersion: 1 });
    },
  );

  it("keeps unknown keys and invalid values exactly as they were", () => {
    const doc = { theme: "neon", future: { nested: [1, 2] } };
    expect(JSON.parse(encodePersistedSettings({ version: 7, ...doc }))).toEqual({
      version: 1,
      ...doc,
    });
  });
});
