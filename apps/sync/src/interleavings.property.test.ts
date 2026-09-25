/**
 * Two clients fire batches of concurrent conditional writes, deletes and renames at one vault.
 * Whatever order the server serializes them in: every accepted change is in the change log at
 * the seq it was acknowledged with, the log is gap-free and totally ordered (and streamed in that
 * order), each accepted conditional change was applied to exactly the rev its client had seen
 * (no lost update), and the files end up as a replay of the log says.
 */
import type { SyncChange } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { expect } from "vitest";
import { filePath, StreamClient, startTestServer, type TestServer } from "./test-helpers";

const PATHS = ["a.md", "b.md", "Notes/c.md"] as const;
const DEVICES = ["dev_one", "dev_two"] as const;

type Precondition = "known" | "absent" | "none";
type Op =
  | { kind: "write"; client: 0 | 1; path: string; precondition: Precondition }
  | { kind: "delete"; client: 0 | 1; path: string; precondition: Exclude<Precondition, "absent"> }
  | { kind: "rename"; client: 0 | 1; path: string; to: string };

const clientArb = fc.constantFrom<0 | 1>(0, 1);
const pathArb = fc.constantFrom(...PATHS);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("write" as const),
      client: clientArb,
      path: pathArb,
      precondition: fc.constantFrom<Precondition>("known", "known", "absent", "none"),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("delete" as const),
      client: clientArb,
      path: pathArb,
      precondition: fc.constantFrom<"known" | "none">("known", "known", "none"),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("rename" as const),
      client: clientArb,
      path: pathArb,
      to: pathArb,
    }),
  },
);
const scenarioArb = fc.array(fc.array(opArb, { minLength: 1, maxLength: 6 }), {
  minLength: 1,
  maxLength: 6,
});

/** 30 runs by default; `FC_NUM_RUNS=1000` (a deep sweep) scales it tenfold. */
const RUNS = Math.max(1, Math.round((30 * Number(process.env.FC_NUM_RUNS ?? 100)) / 100));

interface Accepted {
  op: Op;
  device: string;
  /** What the client sent as `ifMatch` (undefined: unconditional). */
  ifMatch: string | null | undefined;
  content?: string;
  seq: number;
  rev: string | null;
}

async function run(t: TestServer, batches: Op[][]) {
  const views = [new Map<string, string>(), new Map<string, string>()];
  const accepted: Accepted[] = [];
  const rejectedRevs: Array<{
    path: string;
    currentRev: string | null;
    sent: string | null | undefined;
  }> = [];
  let counter = 0;

  for (const batch of batches) {
    const outcomes = await Promise.all(
      batch.map(async (op) => {
        const device = DEVICES[op.client];
        const view = views[op.client]!;
        if (op.kind === "rename") {
          const response = await t.api("POST", "/rename", {
            body: { from: op.path, to: op.to },
            device,
          });
          return { op, device, ifMatch: undefined, content: undefined, response };
        }
        const known = view.get(op.path);
        const ifMatch =
          op.precondition === "none"
            ? undefined
            : op.precondition === "absent"
              ? null
              : (known ?? null);
        if (op.kind === "delete") {
          if (ifMatch === null) return null;
          const response = await t.api("DELETE", filePath(op.path), {
            device,
            ...(ifMatch === undefined ? {} : { query: { ifMatch } }),
          });
          return { op, device, ifMatch, content: undefined, response };
        }
        const content = `content ${counter++}`;
        const response = await t.api("PUT", filePath(op.path), {
          device,
          body: { content, ...(ifMatch === undefined ? {} : { ifMatch }) },
        });
        return { op, device, ifMatch, content, response };
      }),
    );

    for (const outcome of outcomes) {
      if (!outcome) continue;
      const { op, device, ifMatch, content, response } = outcome;
      const view = views[op.client]!;
      if (response.status === 200 || response.status === 201 || response.status === 204) {
        if (op.kind === "write") {
          view.set(op.path, response.body.rev);
          accepted.push({
            op,
            device,
            ifMatch,
            content,
            seq: response.body.seq,
            rev: response.body.rev,
          });
        } else if (op.kind === "rename") {
          view.delete(op.path);
          view.set(op.to, response.body.rev);
          accepted.push({ op, device, ifMatch, seq: response.body.seq, rev: response.body.rev });
        } else {
          view.delete(op.path);
          accepted.push({ op, device, ifMatch, seq: -1, rev: null });
        }
      } else if (response.status === 409 && response.body.error === "conflict") {
        rejectedRevs.push({
          path: op.kind === "rename" ? op.to : op.path,
          currentRev: response.body.currentRev,
          sent: ifMatch,
        });
        if (op.kind !== "rename") {
          if (response.body.currentRev === null) view.delete(op.path);
          else view.set(op.path, response.body.currentRev);
        }
      } else {
        // 404 (nothing to delete or rename), or a write/rename blocked by the folder layout.
        expect([404, 409], JSON.stringify(response.body)).toContain(response.status);
      }
    }
  }
  return { accepted, rejectedRevs };
}

async function changeLog(t: TestServer): Promise<SyncChange[]> {
  const log: SyncChange[] = [];
  for (;;) {
    const page = (
      await t.api("GET", "/changes", { query: { since: String(log.at(-1)?.seq ?? 0), limit: "7" } })
    ).body;
    log.push(...page.changes);
    if (!page.more) return log;
  }
}

test.prop([scenarioArb], { numRuns: RUNS })(
  "concurrent conditional writes never lose an accepted write, and the log stays totally ordered",
  async (batches) => {
    const t = await startTestServer();
    try {
      const stream = await StreamClient.open(t.url, t.a.id, t.a.token);
      await stream.next("ready");
      const { accepted, rejectedRevs } = await run(t, batches);
      const log = await changeLog(t);

      // Gap-free, strictly increasing, and exactly what was acknowledged.
      expect(log.map((c) => c.seq)).toEqual(log.map((_, i) => i + 1));
      const expectedChanges =
        accepted.filter((a) => a.op.kind !== "delete").length +
        accepted.filter((a) => a.op.kind === "rename").length +
        accepted.filter((a) => a.op.kind === "delete").length;
      expect(log).toHaveLength(expectedChanges);
      for (const a of accepted) {
        if (a.op.kind === "delete") continue;
        const change = log[a.seq - 1]!;
        expect(change).toMatchObject({
          path: a.op.kind === "rename" ? a.op.to : a.op.path,
          rev: a.rev,
          deleted: false,
          device: a.device,
        });
        if (a.op.kind === "rename") {
          expect(log[a.seq - 2]).toMatchObject({
            path: a.op.path,
            deleted: true,
            device: a.device,
          });
        }
      }

      // Replay the log: every accepted conditional change met its precondition at its turn.
      const state = new Map<string, { rev: string; content: string }>();
      const history = new Map<string, Set<string>>();
      const contentOf = new Map(
        accepted.filter((a) => a.content !== undefined).map((a) => [a.rev!, a.content!]),
      );
      const deletesLeft = accepted.filter((a) => a.op.kind === "delete");
      for (const change of log) {
        const before = state.get(change.path);
        const writer = accepted.find((a) => a.seq === change.seq && a.op.kind === "write");
        if (writer) {
          if (writer.ifMatch === null) expect(before).toBeUndefined();
          if (typeof writer.ifMatch === "string") expect(before?.rev).toBe(writer.ifMatch);
        }
        if (change.deleted) {
          expect(before).toBeDefined();
          const renamed = accepted.find(
            (a) => a.op.kind === "rename" && a.seq === change.seq + 1 && a.op.path === change.path,
          );
          if (!renamed) {
            const index = deletesLeft.findIndex(
              (d) =>
                d.op.path === change.path &&
                d.device === change.device &&
                (typeof d.ifMatch !== "string" || d.ifMatch === before?.rev),
            );
            expect(index, `delete of ${change.path} at ${change.seq}`).not.toBe(-1);
            deletesLeft.splice(index, 1);
          }
          state.delete(change.path);
        } else {
          const moved = accepted.find((a) => a.op.kind === "rename" && a.seq === change.seq);
          const content = moved
            ? (state.get(moved.op.path)?.content ?? contentOf.get(change.rev!))
            : contentOf.get(change.rev!);
          if (moved) expect(before).toBeUndefined();
          state.set(change.path, { rev: change.rev!, content: content ?? "" });
          history.set(change.path, (history.get(change.path) ?? new Set()).add(change.rev!));
        }
      }
      expect(deletesLeft).toEqual([]);

      // The files are what the replay says.
      const files = (await t.api("GET", "/files")).body.files as Array<{
        path: string;
        rev: string;
      }>;
      expect(files.map((f) => [f.path, f.rev])).toEqual(
        [...state].map(([path, s]) => [path, s.rev]).sort(),
      );
      for (const [path, { content }] of state) {
        expect((await t.api("GET", filePath(path))).body.content).toBe(content);
      }

      // Refusals named a rev the path really had (or none).
      for (const r of rejectedRevs) {
        if (r.currentRev !== null)
          expect(history.get(r.path)?.has(r.currentRev), r.path).toBe(true);
        if (typeof r.sent === "string") expect(r.currentRev).not.toBe(r.sent);
      }

      // The stream delivered the same log, in the same order.
      const streamed = async () =>
        stream.frames
          .filter((f) => f.type === "change")
          .map(({ type: _type, ...change }) => change);
      await expect.poll(streamed, { timeout: 5_000 }).toHaveLength(log.length);
      expect(await streamed()).toEqual(log);
      stream.ws.close();
    } finally {
      await t.close();
    }
  },
  60_000,
);
