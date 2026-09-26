/**
 * Properties of the wire-contract helpers that core logic relies on (`encodeVaultPath` /
 * `decodeVaultPath` for note URLs, `mergeSettings` for settings patches).
 */
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { normalizePath } from "./paths";
import { API_ROUTES, decodeVaultPath, encodeVaultPath } from "./protocol";
import { DEFAULT_SETTINGS, type DeepPartial, mergeSettings } from "./settings";
import type { AppSettings } from "./wire";

const segmentArb = fc.oneof(
  fc.constantFrom(
    "50% off?",
    "C# & notes",
    "#1 a%20b",
    "a+b=c",
    "Café",
    "日記",
    "🎉 party",
    "x.md",
    "?",
    "&",
    "%",
    " ",
  ),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }),
);
/** Normalized vault paths made of arbitrary well-formed Unicode segments. */
const vaultPathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join("/"))
  .map((p) => {
    try {
      return normalizePath(p);
    } catch {
      return "";
    }
  })
  .filter((p) => p !== "");

describe("encodeVaultPath / decodeVaultPath", () => {
  test.prop([vaultPathArb])("round-trip and keep one URL segment per path segment", (path) => {
    const encoded = encodeVaultPath(path);
    expect(decodeVaultPath(encoded)).toBe(path);
    expect(encoded.split("/")).toHaveLength(path.split("/").length);
    expect(encoded).toMatch(/^(?:[A-Za-z0-9\-_.!~*'()/]|%[0-9A-F]{2})*$/);
  });

  test.prop([vaultPathArb])("survive URL parsing untouched inside a note route", (path) => {
    const route = API_ROUTES.note(path);
    const url = new URL(route, "http://127.0.0.1:7331");
    expect(url.pathname).toBe(route);
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(decodeVaultPath(url.pathname.slice("/api/notes/".length))).toBe(path);
  });

  it("rejects malformed escapes when decoding", () => {
    expect(() => decodeVaultPath("a/%E0%A4%A.md")).toThrow(URIError);
  });
});

// ── mergeSettings ────────────────────────────────────────────────────────────────────────────

/** Patches shaped like the value they patch: same-typed leaves, nested objects, arrays. */
function patchOf(value: unknown): fc.Arbitrary<unknown> {
  if (Array.isArray(value)) return fc.array(fc.nat(), { maxLength: 3 });
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([k, v]) => [k, patchOf(v)] as const);
    return fc.record(Object.fromEntries(entries), { requiredKeys: [] });
  }
  if (typeof value === "boolean") return fc.boolean();
  if (typeof value === "number") return fc.integer({ min: 0, max: 100_000 });
  return fc.string({ maxLength: 12 });
}

const settingsPatchArb = patchOf(DEFAULT_SETTINGS) as fc.Arbitrary<DeepPartial<AppSettings>>;

function sameShape(a: unknown, b: unknown): void {
  if (typeof a !== "object" || a === null || Array.isArray(a)) return;
  expect(Object.keys(b as object).sort()).toEqual(Object.keys(a).sort());
  for (const [k, v] of Object.entries(a)) sameShape(v, (b as Record<string, unknown>)[k]);
}

describe("mergeSettings", () => {
  it("returns the base itself for no patch and an equal copy for an empty one", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, undefined)).toBe(DEFAULT_SETTINGS);
    const copy = mergeSettings(DEFAULT_SETTINGS, {});
    expect(copy).toEqual(DEFAULT_SETTINGS);
    expect(copy).not.toBe(DEFAULT_SETTINGS);
  });

  test.prop([settingsPatchArb])(
    "applies well-typed patches leaf by leaf and keeps the shape",
    (patch) => {
      const before = structuredClone(DEFAULT_SETTINGS);
      const patchCopy = structuredClone(patch);
      const merged = mergeSettings(DEFAULT_SETTINGS, patch);
      sameShape(DEFAULT_SETTINGS, merged);
      const check = (base: unknown, p: unknown, out: unknown) => {
        if (p === undefined) return expect(out).toEqual(base);
        if (typeof base === "object" && base !== null && !Array.isArray(base)) {
          for (const k of Object.keys(base)) {
            check(
              (base as Record<string, unknown>)[k],
              (p as Record<string, unknown>)[k],
              (out as Record<string, unknown>)[k],
            );
          }
          return;
        }
        expect(out).toEqual(p);
      };
      check(DEFAULT_SETTINGS, patch, merged);
      expect(DEFAULT_SETTINGS).toEqual(before);
      expect(patch).toEqual(patchCopy);
    },
  );

  test.prop([settingsPatchArb, settingsPatchArb])(
    "is idempotent, and later patches win",
    (p1, p2) => {
      const once = mergeSettings(DEFAULT_SETTINGS, p1);
      expect(mergeSettings(once, p1)).toEqual(once);
      const both = mergeSettings(once, p2);
      expect(mergeSettings(both, p2)).toEqual(both);
    },
  );

  test.prop([fc.dictionary(fc.string({ minLength: 1, maxLength: 8 }), fc.jsonValue())])(
    "drops unknown keys and skips undefined values",
    (junk) => {
      fc.pre(Object.keys(junk).every((k) => !(k in DEFAULT_SETTINGS) && k !== "__proto__"));
      const merged = mergeSettings(DEFAULT_SETTINGS, { ...junk, theme: undefined } as never);
      expect(merged).toEqual(DEFAULT_SETTINGS);
    },
  );

  it("replaces arrays instead of merging them", () => {
    const base = { list: [1, 2, 3], nested: { list: ["a"] } };
    expect(mergeSettings(base, { list: [9], nested: { list: [] } })).toEqual({
      list: [9],
      nested: { list: [] },
    });
  });
});
