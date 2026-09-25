import { basename, dirname, extname, formatDate, isHiddenPath } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import { conflictCopyPath, isConflictCopyPath } from "./conflict-path";
import { decideSync, type SyncDecision } from "./decide";
import {
  emptySnapshot,
  parseSnapshot,
  type SnapshotEntry,
  serializeSnapshot,
  snapshotPath,
} from "./snapshot";

const entry = (version: string): FileEntry => ({ path: "x.md", size: 1, mtime: 0, version });

describe("decideSync", () => {
  type Side = "absent" | "same" | "changed";
  const sides: Side[] = ["absent", "same", "changed"];
  const file = (side: Side, synced: string) =>
    side === "absent" ? undefined : entry(side === "same" ? synced : `${synced}-changed`);

  // [primary, target] → action, when the path was synced before.
  const withBase: Record<`${Side}/${Side}`, SyncDecision["action"]> = {
    "same/same": "skip",
    "same/changed": "pull",
    "same/absent": "delete-primary",
    "changed/same": "push",
    "absent/same": "delete-target",
    "changed/changed": "reconcile",
    "changed/absent": "push",
    "absent/changed": "pull",
    "absent/absent": "forget",
  };

  for (const p of sides) {
    for (const t of sides) {
      it(`synced before, vault ${p}, target ${t} → ${withBase[`${p}/${t}`]}`, () => {
        const primary = file(p, "p0");
        const target = file(t, "t0");
        const decision = decideSync({ p: "p0", t: "t0" }, primary, target);
        expect(decision.action).toBe(withBase[`${p}/${t}`]);
        if ("primary" in decision) expect(decision.primary).toBe(primary);
        if ("target" in decision) expect(decision.target).toBe(target);
      });
    }
  }

  it.each([
    [true, true, "reconcile"],
    [true, false, "push"],
    [false, true, "pull"],
    [false, false, "skip"],
  ] as const)("never synced, vault %s, target %s → %s", (p, t, action) => {
    expect(
      decideSync(undefined, p ? entry("a") : undefined, t ? entry("b") : undefined).action,
    ).toBe(action);
  });

  const versionArb = fc.constantFrom("v1", "v2", "v3");
  test.prop([
    fc.option(fc.record({ p: versionArb, t: versionArb }), { nil: undefined }),
    fc.option(versionArb.map(entry), { nil: undefined }),
    fc.option(versionArb.map(entry), { nil: undefined }),
  ])(
    "only deletes against an unchanged side, and never without a base",
    (base, primary, target) => {
      const { action } = decideSync(base, primary, target);
      if (action === "delete-target") {
        expect(base).toBeDefined();
        expect(primary).toBeUndefined();
        expect(target?.version).toBe(base!.t);
      }
      if (action === "delete-primary") {
        expect(base).toBeDefined();
        expect(target).toBeUndefined();
        expect(primary?.version).toBe(base!.p);
      }
      if (action === "skip") expect(primary?.version ?? null).toBe(base ? base.p : null);
    },
  );
});

describe("sync snapshots", () => {
  const pathArb = fc.oneof(
    fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }),
    fc.constantFrom("__proto__", "constructor", "toString", "Daily/2026-09-23.md", 'a"quote.md'),
  );
  const entryArb: fc.Arbitrary<SnapshotEntry> = fc.record(
    { p: fc.string(), t: fc.string(), b: fc.string({ unit: "grapheme", maxLength: 20 }) },
    { requiredKeys: ["p", "t"] },
  );

  test.prop([
    fc.array(fc.tuple(pathArb, entryArb), { maxLength: 8 }),
    fc.array(pathArb, { maxLength: 3 }),
  ])("round-trip every entry and conflict copy", (entries, conflicts) => {
    const snapshot = emptySnapshot();
    for (const [path, e] of entries) snapshot.entries.set(path, e);
    for (const path of conflicts) snapshot.conflicts.add(path);
    const parsed = parseSnapshot(serializeSnapshot("target-1", snapshot, 42), "target-1");
    expect(parsed).toEqual(snapshot);
  });

  it.each([
    ["not json", "{"],
    ["another target", JSON.stringify({ format: 1, targetId: "other", entries: {} })],
    ["another format", JSON.stringify({ format: 2, targetId: "t", entries: {} })],
    ["entries not an object", JSON.stringify({ format: 1, targetId: "t", entries: [] })],
    ["null", "null"],
  ])("rejects %s", (_name, json) => {
    expect(parseSnapshot(json, "t")).toBeNull();
  });

  it("skips malformed entries and non-string conflicts but keeps the rest", () => {
    const json = JSON.stringify({
      format: 1,
      targetId: "t",
      entries: {
        "ok.md": { p: "1", t: "2", b: "base" },
        "bad.md": { p: 1 },
        "odd.md": { p: "1", t: "2", b: 7 },
      },
      conflicts: ["c.md", 5, null],
    });
    const parsed = parseSnapshot(json, "t")!;
    expect([...parsed.entries]).toEqual([
      ["ok.md", { p: "1", t: "2", b: "base" }],
      ["odd.md", { p: "1", t: "2" }],
    ]);
    expect([...parsed.conflicts]).toEqual(["c.md"]);
  });

  test.prop([fc.string({ unit: "grapheme", maxLength: 30 })])(
    "snapshot file names are safe on any disk",
    (id) => {
      const path = snapshotPath(id);
      expect(path.startsWith(".daily-do-list/sync/")).toBe(true);
      expect(basename(path)).toMatch(/^[A-Za-z0-9._-]*\.json$/);
      expect(path.split("/")).toHaveLength(3);
    },
  );
});

describe("conflictCopyPath", () => {
  const pathArb = fc.constantFrom(
    "Daily/2026-09-23.md",
    "note.md",
    "board.canvas",
    ".env",
    "Folder/.hidden.md",
    "archive.tar.gz",
    "no-extension",
    "Deep/a/b/c.txt",
    "trailing.",
  );
  const dateArb = fc.date({
    min: new Date(2000, 0, 1),
    max: new Date(2099, 0, 1),
    noInvalidDate: true,
  });

  test.prop([pathArb, dateArb, fc.integer({ min: 1, max: 60 })])(
    "stays next to the original with its extension, stamped with local time",
    (path, at, attempt) => {
      const copy = conflictCopyPath(path, at, attempt);
      expect(copy).not.toBe(path);
      expect(dirname(copy)).toBe(dirname(path));
      expect(extname(copy)).toBe(extname(path));
      expect(isHiddenPath(copy)).toBe(isHiddenPath(path));
      const stamp = formatDate(at, "YYYY-MM-DD HHmm");
      expect(basename(copy)).toContain(`(conflict ${stamp}${attempt > 1 ? ` ${attempt}` : ""})`);
    },
  );

  test.prop([pathArb, dateArb])("different attempts never collide", (path, at) => {
    const names = Array.from({ length: 50 }, (_, i) => conflictCopyPath(path, at, i + 1));
    expect(new Set(names).size).toBe(50);
  });

  test.prop([pathArb, dateArb, fc.integer({ min: 1, max: 60 })])(
    "copies are recognizable by name, on any device",
    (path, at, attempt) => {
      expect(isConflictCopyPath(conflictCopyPath(path, at, attempt))).toBe(true);
      expect(isConflictCopyPath(path)).toBe(false);
    },
  );

  it("doesn't mistake ordinary names for copies", () => {
    for (const path of [
      "notes (conflicted).md",
      "Meeting (conflict).md",
      "conflict 2026-09-23 1830.md",
    ]) {
      expect(isConflictCopyPath(path)).toBe(false);
    }
  });
});
