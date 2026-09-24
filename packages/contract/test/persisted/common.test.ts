import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  decodePersisted,
  PERSISTED_FILE_ID_PATTERN,
  PersistedCorruption,
  type PersistedFormatSpec,
  parsePersistedJson,
  persistedQuarantinePath,
} from "../../src/persisted";
import { salvageList, salvageRecord } from "../../src/persisted/common";

describe("parsePersistedJson", () => {
  it("strips a UTF-8 byte order mark", () => {
    expect(parsePersistedJson('\uFEFF{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it.each([
    ["empty", ""],
    ["whitespace only", " \n\t "],
    ["a lone BOM", "\uFEFF"],
  ])("rejects an %s file", (_label, text) => {
    expect(parsePersistedJson(text)).toEqual({ ok: false, reason: "empty file" });
  });

  it("rejects truncated JSON without echoing its content", () => {
    const secret = '{"text":"call Dr. Example about the biopsy results';
    const result = parsePersistedJson(secret);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("biopsy");
  });

  test.prop([fc.string({ unit: "binary", maxLength: 200 })])("never throws", (text) => {
    const result = parsePersistedJson(text);
    expect(typeof result.ok).toBe("boolean");
  });
});

/** A toy format at v3 with a legacy migration and two numbered steps. */
const toy: PersistedFormatSpec<{ items: string[]; label: string }> = {
  version: 3,
  migrateUnversioned: (doc) => ({ ...doc, version: 1, entries: doc.list ?? [] }),
  migrations: {
    1: (doc) => ({ ...doc, version: 2, items: doc.entries }),
    2: (doc) => ({ ...doc, version: 3, label: typeof doc.name === "string" ? doc.name : "" }),
  },
  read(doc, issues) {
    const envelope = z.object({ items: z.array(z.unknown()), label: z.string() }).safeParse(doc);
    if (!envelope.success) return new PersistedCorruption("bad envelope");
    return {
      items: salvageList(envelope.data.items, z.string(), "items", issues),
      label: envelope.data.label,
    };
  },
};

describe("decodePersisted", () => {
  it("runs every migration step from an old version up to the current one", () => {
    expect(decodePersisted(toy, '{"version":1,"entries":["a"],"name":"n"}')).toEqual({
      ok: true,
      value: { items: ["a"], label: "n" },
      fromVersion: 1,
      issues: [],
    });
    expect(decodePersisted(toy, '{"version":2,"items":["b"]}')).toMatchObject({
      ok: true,
      value: { items: ["b"], label: "" },
      fromVersion: 2,
    });
  });

  it("upgrades legacy files without `version` and reports them as fromVersion null", () => {
    expect(decodePersisted(toy, '{"list":["x"],"name":"old"}')).toEqual({
      ok: true,
      value: { items: ["x"], label: "old" },
      fromVersion: null,
      issues: [],
    });
  });

  it("refuses legacy files when the format never had an unversioned shape", () => {
    const { migrateUnversioned: _, ...strict } = toy;
    expect(decodePersisted(strict, '{"items":[],"label":""}')).toEqual({
      ok: false,
      kind: "corrupt",
      reason: "missing `version`",
    });
  });

  it("reports newer versions without reading them", () => {
    expect(decodePersisted(toy, '{"version":4,"anything":{"goes":true}}')).toEqual({
      ok: false,
      kind: "newer",
      version: 4,
    });
    expect(decodePersisted(toy, '{"version":999999}')).toMatchObject({ kind: "newer" });
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["a string", '"3"'],
    ["null", "null"],
    ["an object", "{}"],
    ["beyond safe integers", "9007199254740993"],
  ])("treats a `version` that is %s as corrupt", (_label, version) => {
    expect(decodePersisted(toy, `{"version":${version},"items":[],"label":""}`)).toMatchObject({
      ok: false,
      kind: "corrupt",
    });
  });

  it.each([
    ["an array", "[]"],
    ["a string", '"hello"'],
    ["a number", "42"],
    ["null", "null"],
  ])("treats a top level that is %s as corrupt", (_label, text) => {
    expect(decodePersisted(toy, text)).toEqual({
      ok: false,
      kind: "corrupt",
      reason: "top level is not a JSON object",
    });
  });

  it("reports a missing migration step as corrupt", () => {
    const gap = { ...toy, migrations: { 2: toy.migrations![2]! } };
    expect(decodePersisted(gap, '{"version":1,"entries":[]}')).toEqual({
      ok: false,
      kind: "corrupt",
      reason: "no migration from version 1",
    });
  });

  it("salvages list entries and reports each one it drops", () => {
    expect(decodePersisted(toy, '{"version":3,"items":["a",1,"b",null],"label":""}')).toMatchObject(
      {
        ok: true,
        value: { items: ["a", "b"] },
        issues: [{ path: "items[1]" }, { path: "items[3]" }],
      },
    );
  });

  test.prop([fc.jsonValue()])("is total over arbitrary JSON documents", (value) => {
    const result = decodePersisted(toy, JSON.stringify(value));
    expect(["corrupt", "newer", true]).toContain(result.ok ? true : result.kind);
  });
});

describe("salvage helpers", () => {
  const Item = z.object({ id: z.string(), n: z.number() });

  it("replays keyed lists as upserts: first position, last value", () => {
    const issues: Array<{ path: string; message: string }> = [];
    const out = salvageList(
      [
        { id: "a", n: 1 },
        { id: "b", n: 2 },
        { id: "a", n: 3 },
      ],
      Item,
      "list",
      issues,
      (item) => item.id,
    );
    expect(out).toEqual([
      { id: "a", n: 3 },
      { id: "b", n: 2 },
    ]);
    expect(issues).toEqual([
      { path: "list[2]", message: 'duplicate id "a" (the last entry wins)' },
    ]);
  });

  it("drops keyed values whose key does not match their id", () => {
    const issues: Array<{ path: string; message: string }> = [];
    const out = salvageRecord(
      { a: { id: "a", n: 1 }, b: { id: "x", n: 2 }, c: { id: "c" } },
      Item,
      "map",
      issues,
      (key, item) => key === item.id,
    );
    expect(out).toEqual({ a: { id: "a", n: 1 } });
    expect(issues.map((issue) => issue.path)).toEqual(["map.b", "map.c"]);
  });
});

describe("persistedQuarantinePath", () => {
  const at = new Date(Date.UTC(2026, 8, 23, 21, 58, 0, 123));

  it("mirrors the sidecar path under corrupt/ with a sortable UTC stamp", () => {
    expect(persistedQuarantinePath(".daily-do-list/threads/thr_a.json", at)).toBe(
      ".daily-do-list/corrupt/threads/thr_a.20260923T215800123Z.json",
    );
    expect(persistedQuarantinePath(".daily-do-list/settings.json", at, 3)).toBe(
      ".daily-do-list/corrupt/settings.20260923T215800123Z-3.json",
    );
    expect(persistedQuarantinePath(".daily-do-list/state/tasks/0a1b.json", at)).toBe(
      ".daily-do-list/corrupt/state/tasks/0a1b.20260923T215800123Z.json",
    );
  });

  it("keeps names without an extension readable", () => {
    expect(persistedQuarantinePath(".daily-do-list/state/LOCK", at)).toBe(
      ".daily-do-list/corrupt/state/LOCK.20260923T215800123Z",
    );
  });

  it("never produces characters that are invalid in file names", () => {
    expect(persistedQuarantinePath(".daily-do-list/threads/t.json", at)).not.toMatch(/[:\\*?"<>|]/);
  });
});

describe("file ids", () => {
  it.each(["thr_k3j9x0q2m1ab", "thread-1", "A", "x_y-z"])("accepts %s", (id) => {
    expect(PERSISTED_FILE_ID_PATTERN.test(id)).toBe(true);
  });

  it.each([
    "",
    "..",
    "../state/records",
    "a/b",
    "a\\b",
    ".hidden",
    "-leading-dash",
    "has space",
    "nul\0",
    "x".repeat(129),
  ])("rejects %j", (id) => {
    expect(PERSISTED_FILE_ID_PATTERN.test(id)).toBe(false);
  });
});
