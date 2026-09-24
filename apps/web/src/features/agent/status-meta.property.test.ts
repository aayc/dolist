import type { TaskAgentStatus, ThreadSummary } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { isSameLocalDay } from "../../lib/format";
import { groupThreads, INBOX_GROUPS, inboxGroupOf } from "./status-meta";

const STATUSES: readonly TaskAgentStatus[] = [
  "idle",
  "triaging",
  "queued",
  "working",
  "waiting_approval",
  "waiting_user",
  "done",
  "failed",
  "cancelled",
  "ignored",
];

// Local noon on a fixed day; offsets reach across the previous/next midnight.
const NOW = new Date(2026, 8, 23, 12, 0).getTime();
const HOUR = 3_600_000;
const offset = fc.integer({ min: -60 * HOUR, max: 30 * HOUR });

const thread: fc.Arbitrary<ThreadSummary> = fc.record({
  id: fc.uuid(),
  taskId: fc.option(fc.constant("tsk_1"), { nil: null }),
  notePath: fc.constant("Daily/2026-09-23.md"),
  title: fc.constant("Task"),
  status: fc.constantFrom(...STATUSES),
  createdAt: offset.map((o) => NOW + o),
  updatedAt: offset.map((o) => NOW + o),
  messageCount: fc.nat({ max: 3 }),
  artifactCount: fc.nat({ max: 1 }),
  surfaces: fc.constant([]),
  pendingApprovals: fc.oneof(fc.constant(0), fc.nat({ max: 2 })),
});

describe("inbox grouping (properties)", () => {
  test.prop([fc.uniqueArray(thread, { selector: (t) => t.id, maxLength: 30 })])(
    "shows today's threads plus anything still needing attention, each once, newest first",
    (threads) => {
      const groups = groupThreads(threads, NOW);
      const shown = INBOX_GROUPS.flatMap(({ key }) => groups[key]);
      expect(new Set(shown.map((t) => t.id)).size).toBe(shown.length);
      for (const { key } of INBOX_GROUPS) {
        const list = groups[key];
        for (const t of list) expect(inboxGroupOf(t)).toBe(key);
        for (let i = 1; i < list.length; i++) {
          expect(list[i - 1]!.updatedAt).toBeGreaterThanOrEqual(list[i]!.updatedAt);
        }
      }
      for (const t of threads) {
        const group = inboxGroupOf(t);
        const today = isSameLocalDay(t.updatedAt, NOW) || isSameLocalDay(t.createdAt, NOW);
        const expected = today || group === "needs_you" || group === "working";
        expect(shown.includes(t), `${t.status}/${t.pendingApprovals}`).toBe(expected);
      }
    },
  );

  test.prop([fc.constantFrom(...STATUSES), fc.integer({ min: 1, max: 5 })])(
    "a pending approval always puts the thread in Needs you",
    (status, pendingApprovals) => {
      expect(inboxGroupOf({ status, pendingApprovals })).toBe("needs_you");
    },
  );

  it("drops finished threads at local midnight, keeps waiting ones", () => {
    const midnight = new Date(2026, 8, 23, 0, 0).getTime();
    const base: ThreadSummary = {
      id: "t",
      taskId: null,
      notePath: null,
      title: "x",
      status: "done",
      createdAt: midnight - 1,
      updatedAt: midnight - 1,
      messageCount: 0,
      artifactCount: 0,
      surfaces: [],
      pendingApprovals: 0,
    };
    const groups = groupThreads(
      [
        base,
        { ...base, id: "just-after", updatedAt: midnight },
        { ...base, id: "waiting", status: "waiting_user" },
      ],
      NOW,
    );
    expect(groups.done.map((t) => t.id)).toEqual(["just-after"]);
    expect(groups.needs_you.map((t) => t.id)).toEqual(["waiting"]);
  });
});
