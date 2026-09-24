/**
 * The settings file (persisted contract) and the settings API (wire contract) declare the same
 * value ranges independently; a value accepted over the wire must also be storable, and the
 * boundaries must agree, or a saved setting would silently fall back to its default on reload.
 */
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { PersistedSettingsOverridesSchema } from "../../src/persisted";
import { arb } from "../../src/testing";
import { SETTINGS_RANGES, UpdateSettingsRequestSchema } from "../../src/wire";

type Patch = Record<string, Record<string, unknown>>;

const numeric: Array<[string, (value: number) => Patch, { min: number; max: number }, boolean]> = [
  ["editor.fontSize", (v) => ({ editor: { fontSize: v } }), SETTINGS_RANGES.fontSize, false],
  ["agent.settleMs", (v) => ({ agent: { settleMs: v } }), SETTINGS_RANGES.settleMs, true],
  [
    "agent.maxConcurrentSubagents",
    (v) => ({ agent: { maxConcurrentSubagents: v } }),
    SETTINGS_RANGES.maxConcurrentSubagents,
    true,
  ],
  [
    "agent.watch.pastDays",
    (v) => ({ agent: { watch: { pastDays: v } } }),
    SETTINGS_RANGES.watchDays,
    true,
  ],
  [
    "agent.approvalTimeoutMs",
    (v) => ({ agent: { approvalTimeoutMs: v } }),
    SETTINGS_RANGES.approvalTimeoutMs,
    true,
  ],
];

describe("wire ⇄ persisted settings ranges", () => {
  test.prop([arb.updateSettingsRequest()])(
    "every valid wire patch is a valid stored override",
    (patch) => {
      const stored = PersistedSettingsOverridesSchema.safeParse(patch);
      expect(stored.error?.issues ?? []).toEqual([]);
    },
  );

  it.each(numeric)("%s has the same bounds in both", (_name, patch, range, integer) => {
    const both = (value: number) => [
      UpdateSettingsRequestSchema.safeParse(patch(value)).success,
      PersistedSettingsOverridesSchema.safeParse(patch(value)).success,
    ];
    expect(both(range.min)).toEqual([true, true]);
    expect(both(range.max)).toEqual([true, true]);
    expect(both(range.min - 1)).toEqual([false, false]);
    expect(both(range.max + 1)).toEqual([false, false]);
    if (integer) expect(both(range.min + 0.5)).toEqual([false, false]);
  });

  it.each([
    [
      "dailyNotes.folder",
      SETTINGS_RANGES.folderLength,
      (v: string) => ({ dailyNotes: { folder: v } }),
    ],
    [
      "dailyNotes.format",
      SETTINGS_RANGES.formatLength,
      (v: string) => ({ dailyNotes: { format: v } }),
    ],
    [
      "weeklyNotes.template",
      SETTINGS_RANGES.templateLength,
      (v: string) => ({ weeklyNotes: { template: v } }),
    ],
    ["editor.vimrc", SETTINGS_RANGES.vimrcLength, (v: string) => ({ editor: { vimrc: v } })],
  ] as const)("%s has the same length limit in both", (_name, max, patch) => {
    for (const [value, ok] of [
      ["x".repeat(max), true],
      ["x".repeat(max + 1), false],
    ] as const) {
      expect(UpdateSettingsRequestSchema.safeParse(patch(value)).success).toBe(ok);
      expect(PersistedSettingsOverridesSchema.safeParse(patch(value)).success).toBe(ok);
    }
  });

  const MODEL_KEYS = ["model", "cursorModel", "judgeModel"] as const;

  test.prop([fc.constantFrom(...MODEL_KEYS), fc.constantFrom("", "   ", "m".repeat(201))])(
    "both reject unusable model ids",
    (key, value) => {
      const patch = { agent: { [key]: value } };
      expect(UpdateSettingsRequestSchema.safeParse(patch).success).toBe(false);
      expect(PersistedSettingsOverridesSchema.safeParse(patch).success).toBe(false);
    },
  );

  test.prop([
    fc.constantFrom(...MODEL_KEYS),
    arb.cursorModelId(),
    fc.constantFrom("", " ", "\t\n"),
  ])("both trim model ids the same way", (key, id, padding) => {
    const patch = { agent: { [key]: `${padding}${id}${padding}` } };
    const expected = { agent: { [key]: id } };
    expect(UpdateSettingsRequestSchema.parse(patch)).toEqual(expected);
    expect(PersistedSettingsOverridesSchema.parse(patch)).toEqual(expected);
  });

  it("both accept exactly the known harnesses", () => {
    for (const [harness, ok] of [
      ["pi", true],
      ["cursor", true],
      ["claude", false],
      ["Cursor", false],
      ["", false],
      [1, false],
      [null, false],
    ] as const) {
      const patch = { agent: { harness } };
      expect(UpdateSettingsRequestSchema.safeParse(patch).success, String(harness)).toBe(ok);
      expect(PersistedSettingsOverridesSchema.safeParse(patch).success, String(harness)).toBe(ok);
    }
  });
});
