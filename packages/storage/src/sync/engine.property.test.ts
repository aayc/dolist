import { fc, test } from "@fast-check/vitest";
import { describe, expect, it, vi } from "vitest";
import { isBinaryPath, isMergeablePath } from "../file-types";
import { MemoryStorageProvider } from "../memory";
import type { StorageProvider, SyncReport } from "../types";
import { mergeText } from "./diff3";
import { SyncAbortedError, SyncEngine } from "./engine";
import { SYNC_STATE_DIR } from "./snapshot";

const NOW = new Date(2026, 8, 23, 18, 30).getTime();
const PATHS = [
  "a.md",
  "b.md",
  "Daily/2026-09-23.md",
  "Daily/2026-09-24.md",
  "notes.txt",
  "board.canvas",
  "Deep/x/y.md",
];
/** 60 runs by default; a deep sweep (`FC_NUM_RUNS=1000`) scales it tenfold. */
const RUNS = Math.max(1, Math.round((60 * Number(process.env.FC_NUM_RUNS ?? 100)) / 100));
/** Never touched by edits, so neither side ever lists as empty (see the mass-deletion tests). */
const KEEP = "keep.md";

type Files = Map<string, string>;
type OpKind =
  | "create"
  | "append"
  | "prepend"
  | "replace"
  | "deleteLine"
  | "delete"
  | "rewrite"
  | "same";
interface Op {
  path: string;
  kind: OpKind;
  at: number;
}

const opArb: fc.Arbitrary<Op> = fc.record({
  path: fc.constantFrom(...PATHS),
  kind: fc.constantFrom<OpKind>(
    "create",
    "append",
    "append",
    "prepend",
    "replace",
    "deleteLine",
    "delete",
    "rewrite",
    "same",
  ),
  at: fc.nat(),
});
const POOL = ["- [ ] shared task", "- [x] done", "# Heading", "", "plain note"];
const initialArb = fc.dictionary(
  fc.constantFrom(...PATHS),
  fc.array(fc.constantFrom(...POOL), { maxLength: 4 }).map((lines) => lines.join("\n")),
  { maxKeys: PATHS.length },
);
const scenarioArb = fc.record({
  primary: initialArb,
  target: initialArb,
  rounds: fc.array(
    fc.record({
      primary: fc.array(opArb, { maxLength: 5 }),
      target: fc.array(opArb, { maxLength: 5 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
});

/** Applies one edit; new lines are unique (`side/round/n`) so they can be traced afterwards. */
async function apply(provider: StorageProvider, op: Op, tag: string): Promise<void> {
  const current = (await provider.read(op.path))?.content ?? null;
  const lines = current === null || current === "" ? [] : current.split("\n");
  const fresh = `${tag} line`;
  let next: string | null;
  switch (op.kind) {
    case "create":
      next = current ?? fresh;
      break;
    case "append":
      next = [...lines, fresh].join("\n");
      break;
    case "prepend":
      next = [fresh, ...lines].join("\n");
      break;
    case "replace":
      next =
        lines.length === 0
          ? fresh
          : lines.map((l, i) => (i === op.at % lines.length ? fresh : l)).join("\n");
      break;
    case "deleteLine":
      next = lines.filter((_, i) => i !== op.at % Math.max(1, lines.length)).join("\n");
      break;
    case "rewrite":
      next = `${fresh} (rewritten)\n${fresh} (second)`;
      break;
    case "same":
      next = current;
      break;
    case "delete":
      next = null;
      break;
  }
  if (next === null) {
    if (current !== null) await provider.delete(op.path);
  } else if (next !== current || op.kind === "same") {
    await provider.write(op.path, next);
  }
}

async function snapshotOf(provider: StorageProvider): Promise<Files> {
  const out: Files = new Map();
  for (const entry of await provider.list({ includeHidden: true })) {
    if (entry.path.startsWith(`${SYNC_STATE_DIR}/`)) continue;
    out.set(entry.path, (await provider.read(entry.path))!.content);
  }
  return out;
}

const linesOf = (text: string | undefined) => new Set(text ? text.split("\n") : []);
const changed = (side: Files, base: Files | null, path: string) =>
  base === null ? side.has(path) : side.get(path) !== base.get(path);

function checkRun(
  before: { p: Files; t: Files; base: Files | null },
  report: SyncReport,
  after: Files,
): void {
  const { p, t, base } = before;
  const copiesOf = (path: string) =>
    report.conflicts.filter((c) => c.path === path).map((c) => after.get(c.conflictPath) ?? "");
  for (const path of new Set([...p.keys(), ...t.keys(), ...(base?.keys() ?? [])])) {
    if (path.includes("(conflict ")) continue;
    const baseText = base?.get(path);
    const inP = p.get(path);
    const inT = t.get(path);
    // No lost user text: every line a side added survives, in the file or in its conflict copy.
    for (const [side, text] of [
      ["vault", inP],
      ["target", inT],
    ] as const) {
      if (text === undefined || !changed(side === "vault" ? p : t, base, path)) continue;
      const kept = new Set([
        ...linesOf(after.get(path)),
        ...copiesOf(path).flatMap((c) => [...linesOf(c)]),
      ]);
      for (const line of linesOf(text)) {
        if (!linesOf(baseText).has(line))
          expect(kept.has(line), `${side} line ${JSON.stringify(line)} of ${path}`).toBe(true);
      }
    }
    // Deletes only propagate against an unchanged side; a modified file is restored.
    if (base?.has(path)) {
      if (inP === undefined && inT !== undefined) {
        expect(after.get(path)).toBe(inT === baseText ? undefined : inT);
      }
      if (inT === undefined && inP !== undefined) {
        expect(after.get(path)).toBe(inP === baseText ? undefined : inP);
      }
    }
    if (inP === undefined && inT === undefined) expect(after.has(path)).toBe(false);
    // A side that didn't change the file takes the other side's version.
    if (inP !== undefined && inT !== undefined && base?.has(path)) {
      if (inP === baseText) expect(after.get(path)).toBe(inT);
      if (inT === baseText) expect(after.get(path)).toBe(inP);
    }
    // Conflict copies exactly when both changed it and no clean merge exists.
    if (inP !== undefined && inT !== undefined) {
      const bothChanged = baseText === undefined || (inP !== baseText && inT !== baseText);
      const merged =
        baseText !== undefined && isMergeablePath(path)
          ? mergeText(baseText, inP, inT, { unionInsertions: true })
          : null;
      const trueConflict = bothChanged && inP !== inT && !merged?.clean;
      expect(copiesOf(path).length > 0, `conflict copy for ${path}`).toBe(trueConflict);
      if (trueConflict && isMergeablePath(path)) expect(after.get(path)).toBe(inP);
      if (bothChanged && merged?.clean) expect(after.get(path)).toBe(merged.text);
    }
  }
}

const emptyReport = {
  pushed: [],
  pulled: [],
  deletedLocal: [],
  deletedRemote: [],
  merged: [],
  conflicts: [],
};

describe("SyncEngine (memory ↔ memory) under divergent edits", () => {
  test.prop([scenarioArb], { numRuns: RUNS })(
    "converges, is idempotent, loses no text and conflicts only on true conflicts",
    async (scenario) => {
      let clock = NOW;
      const tick = () => clock++;
      const primary = new MemoryStorageProvider({ id: "vault", now: tick });
      const target = new MemoryStorageProvider({ id: "mirror", now: tick });
      const engine = new SyncEngine({ primary, target, now: () => NOW });
      for (const [path, content] of Object.entries(scenario.primary))
        await primary.write(path, content);
      for (const [path, content] of Object.entries(scenario.target))
        await target.write(path, content);
      await primary.write(KEEP, "keep");
      await target.write(KEEP, "keep");

      let base: Files | null = null;
      const rounds = [{ primary: [], target: [] }, ...scenario.rounds];
      for (const [round, edits] of rounds.entries()) {
        for (const [n, op] of edits.primary.entries())
          await apply(primary, op, `vault/${round}/${n}`);
        for (const [n, op] of edits.target.entries())
          await apply(target, op, `target/${round}/${n}`);
        const before = { p: await snapshotOf(primary), t: await snapshotOf(target), base };
        const report = await engine.syncOnce();
        const after = await snapshotOf(primary);
        expect(await snapshotOf(target)).toEqual(after);
        checkRun(before, report, after);
        expect(await engine.syncOnce()).toMatchObject(emptyReport);
        expect(await snapshotOf(primary)).toEqual(after);
        expect(engine.status()).toMatchObject({ state: "idle", pendingChanges: 0 });
        base = after;
      }
    },
  );
});

describe("SyncEngine reacting to the target's change reports", () => {
  const TARGET_DEBOUNCE_MS = 100;
  const reportArb = fc.record({
    /** Written through the target provider (its own change) rather than by someone else. */
    self: fc.boolean(),
    path: fc.constantFrom(
      "a.md",
      "Daily/2026-09-24.md",
      ".daily-do-list/threads/t.json",
      `${SYNC_STATE_DIR}/other-device.json`,
      "photo.png",
      "Notes/a.md~",
    ),
    content: fc.constantFrom("one", "two\n", "- [ ] three\n"),
    /** Reported together with the next one, within the quiet period. */
    burst: fc.boolean(),
  });

  test.prop([fc.array(reportArb, { minLength: 1, maxLength: 12 })], { numRuns: RUNS })(
    "runs once per quiet period with a foreign syncable change, never for its own or unsyncable ones",
    async (reports) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const primary = new MemoryStorageProvider({ id: "vault" });
      const target = new MemoryStorageProvider({ id: "mirror" });
      const engine = new SyncEngine({ primary, target, now: () => NOW });
      let runs = 0;
      engine.onStatus((status) => {
        if (status.state === "syncing") runs++;
      });
      try {
        engine.start({
          debounceMs: 60_000,
          intervalMs: 3_600_000,
          targetDebounceMs: TARGET_DEBOUNCE_MS,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(runs).toBe(1);

        let expected = 1;
        let pendingForeign = false;
        for (const report of reports) {
          if (report.self) await target.write(report.path, report.content);
          else target.simulateExternalChange(report.path, report.content);
          const syncable =
            !report.path.startsWith(`${SYNC_STATE_DIR}/`) &&
            !isBinaryPath(report.path) &&
            !report.path.endsWith("~");
          pendingForeign ||= !report.self && syncable;
          if (report.burst) {
            // Short enough that even 12 reports in a row stay within one quiet period.
            await vi.advanceTimersByTimeAsync(TARGET_DEBOUNCE_MS / 16);
            continue;
          }
          await vi.advanceTimersByTimeAsync(TARGET_DEBOUNCE_MS * 2);
          if (pendingForeign) expected++;
          pendingForeign = false;
          expect(runs).toBe(expected);
        }
        await vi.advanceTimersByTimeAsync(TARGET_DEBOUNCE_MS * 2);
        if (pendingForeign) expected++;
        expect(runs).toBe(expected);

        await engine.syncOnce();
        const synced = async (provider: StorageProvider) =>
          [...(await snapshotOf(provider))].filter(([path]) => !isBinaryPath(path));
        expect(await synced(primary)).toEqual(await synced(target));
      } finally {
        await engine.stop();
        vi.useRealTimers();
      }
    },
  );
});

describe("SyncEngine mass-deletion guard", () => {
  const guardArb = fc.record({
    files: fc.uniqueArray(fc.constantFrom(...PATHS), { minLength: 1, maxLength: 5 }),
    wiped: fc.constantFrom<"vault" | "target">("vault", "target"),
    // What happened to each file on the surviving side: nothing, an edit, or a deletion.
    fate: fc.array(fc.constantFrom<"same" | "edited" | "deleted">("same", "edited", "deleted"), {
      minLength: 5,
      maxLength: 5,
    }),
    created: fc.boolean(),
  });

  test.prop([guardArb], { numRuns: RUNS })(
    "refuses exactly when an empty side would delete synced files from the other",
    async ({ files, wiped, fate, created }) => {
      const primary = new MemoryStorageProvider({ id: "vault" });
      const target = new MemoryStorageProvider({ id: "mirror" });
      const engine = new SyncEngine({ primary, target, now: () => NOW });
      for (const path of files) await primary.write(path, `synced ${path}`);
      await engine.syncOnce();

      const [empty, survivor] = wiped === "vault" ? [primary, target] : [target, primary];
      for (const path of files) await empty.delete(path);
      for (const [i, path] of files.entries()) {
        if (fate[i] === "edited") await survivor.write(path, `edited ${path}`);
        if (fate[i] === "deleted") await survivor.delete(path);
      }
      if (created) await survivor.write("brand-new.md", "new");
      const survivorBefore = await snapshotOf(survivor);
      const doomed = files.filter((_, i) => fate[i] === "same").length;

      if (doomed > 0) {
        await expect(engine.syncOnce()).rejects.toBeInstanceOf(SyncAbortedError);
        expect(engine.status().lastError).toMatch(
          new RegExp(`refusing to delete ${doomed} synced file`),
        );
        expect(await snapshotOf(survivor)).toEqual(survivorBefore);
      } else {
        await engine.syncOnce();
        expect(await snapshotOf(empty)).toEqual(survivorBefore);
        expect(await snapshotOf(survivor)).toEqual(survivorBefore);
      }
    },
  );

  it("defers evicted cloud placeholders instead of refusing or deleting", async () => {
    const primary = new MemoryStorageProvider({ id: "vault" });
    const target = new MemoryStorageProvider({ id: "mirror" });
    const engine = new SyncEngine({ primary, target, now: () => NOW });
    await primary.write("Daily/a.md", "a");
    await primary.write("b.md", "b");
    await engine.syncOnce();
    await target.delete("Daily/a.md");
    await target.delete("b.md");
    await target.write("Daily/.a.md.icloud", "placeholder");
    await target.write(".b.md.icloud", "placeholder");
    expect(await engine.syncOnce()).toMatchObject(emptyReport);
    expect(await snapshotOf(primary)).toEqual(
      new Map([
        ["Daily/a.md", "a"],
        ["b.md", "b"],
      ]),
    );
    expect(engine.status().pendingChanges).toBe(2);
  });
});
