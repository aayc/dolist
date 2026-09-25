/**
 * The golden files are the compatibility promise: every build must classify them exactly as their
 * names say. Exact loaded state is asserted by the owners' loader tests
 * (packages/agent/test/persistence, apps/daemon/src/settings-store.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  decodePersistedApprovals,
  decodePersistedRecords,
  decodePersistedRoutines,
  decodePersistedSettings,
  decodePersistedTaskState,
  decodePersistedThread,
  PERSISTED_FORMATS,
  type PersistedDecodeResult,
  type PersistedSettingsDocument,
  resolvePersistedSettings,
} from "../../src/persisted";
import {
  FIXTURE_FORMATS,
  type FixtureFormat,
  type FixtureKind,
  fixtureKind,
  listFixtures,
  readFixture,
} from "./fixtures";

const DECODERS: Record<FixtureFormat, (text: string) => PersistedDecodeResult<unknown>> = {
  threads: decodePersistedThread,
  records: decodePersistedRecords,
  approvals: decodePersistedApprovals,
  "task-state": (text) => decodePersistedTaskState(text, "Daily/2026-09-23.md"),
  routines: decodePersistedRoutines,
  settings: decodePersistedSettings,
};

describe.each(FIXTURE_FORMATS)("%s fixtures", (format) => {
  const names = listFixtures(format);

  it("cover every kind of file", () => {
    const kinds = new Set(names.map(fixtureKind));
    expect([...kinds].sort()).toEqual([
      "corrupt",
      "future",
      "legacy",
      "v1",
    ] satisfies FixtureKind[]);
    expect(names.filter((name) => fixtureKind(name) === null)).toEqual([]);
  });

  it.each(names)("%s decodes as its name promises", (name) => {
    const result = DECODERS[format](readFixture(format, name));
    switch (fixtureKind(name)) {
      case "v1": {
        expect(result).toMatchObject({ ok: true, fromVersion: 1 });
        if (!result.ok) break;
        // Settings are never repaired: their invalid values are ignored field by field instead.
        const problems =
          format === "settings"
            ? resolvePersistedSettings(result.value as PersistedSettingsDocument).invalid
            : result.issues;
        if (name.includes("invalid")) expect(problems.length).toBeGreaterThan(0);
        else expect(problems).toEqual([]);
        break;
      }
      case "legacy":
        expect(result).toMatchObject({ ok: true, fromVersion: null, issues: [] });
        break;
      case "corrupt":
        expect(result).toMatchObject({ ok: false, kind: "corrupt" });
        break;
      case "future":
        expect(result).toMatchObject({ ok: false, kind: "newer" });
        break;
      default:
        throw new Error(`unclassified fixture ${name}`);
    }
  });
});

describe("fixture coverage", () => {
  it("has fixtures for every versioned format in the registry", () => {
    const covered: Record<string, FixtureFormat> = {
      thread: "threads",
      records: "records",
      approvals: "approvals",
      "task-state": "task-state",
      routines: "routines",
      settings: "settings",
    };
    for (const format of PERSISTED_FORMATS) {
      if (format.version === null) continue;
      expect(covered[format.name], format.name).toBeDefined();
    }
  });

  it("keeps the artifact bodies the thread fixture points at", () => {
    expect(readFixture("artifacts", "thr_k3j9x0q2m1ab/art_plan01.md")).toContain("# Shortlist");
    expect(readFixture("artifacts", "thr_k3j9x0q2m1ab/art_shot01.png.b64")).toMatch(/^iVBORw0KGgo/);
  });
});
