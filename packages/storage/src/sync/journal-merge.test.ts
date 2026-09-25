import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { isJournalPath } from "../file-types";
import { mergeJournals } from "./journal-merge";

const line = (id: string, seq: number, epoch = 0, extra = "") =>
  `${JSON.stringify({ v: 1, id, epoch, seq, at: 1, type: "title", title: `${id}${extra}` })}\n`;

const eventArb = fc
  .record({
    id: fc.stringMatching(/^evt_[a-z0-9]{1,4}$/),
    epoch: fc.nat({ max: 3 }),
    seq: fc.nat({ max: 20 }),
  })
  .map(({ id, epoch, seq }) => line(id, seq, epoch));
const junkArb = fc.constantFrom('{"v":1,"id":"cut', "not json", "[1,2]", '{"id":7}');
const journalArb = fc
  .array(
    fc.oneof(
      { weight: 5, arbitrary: eventArb },
      { weight: 1, arbitrary: junkArb.map((j) => `${j}\n`) },
    ),
    {
      maxLength: 12,
    },
  )
  .map((lines) => lines.join(""));

/** Each distinct event id with the smallest line carrying it. */
function eventIds(journal: string): string[] {
  const ids = new Set<string>();
  for (const text of journal.split("\n")) {
    try {
      const value = JSON.parse(text) as { id?: unknown; seq?: unknown };
      if (typeof value.id === "string" && typeof value.seq === "number") ids.add(value.id);
    } catch {}
  }
  return [...ids].sort();
}

describe("mergeJournals", () => {
  it("keeps every event of both copies once, in (epoch, seq, id) order", () => {
    const base = line("evt_a", 1) + line("evt_b", 2);
    const ours = base + line("evt_ours", 3);
    const theirs = base + line("evt_theirs", 3) + line("evt_later", 1, 1);
    expect(mergeJournals(ours, theirs)).toBe(
      line("evt_a", 1) +
        line("evt_b", 2) +
        line("evt_ours", 3) +
        line("evt_theirs", 3) +
        line("evt_later", 1, 1),
    );
  });

  it("keeps lines that aren't events after the events, and a cut-off last line on its own line", () => {
    const ours = `${line("evt_a", 1)}{"v":1,"id":"evt_cut","ep`;
    const theirs = `${line("evt_b", 2)}garbage\n`;
    expect(mergeJournals(ours, theirs)).toBe(
      `${line("evt_a", 1)}${line("evt_b", 2)}garbage\n{"v":1,"id":"evt_cut","ep\n`,
    );
  });

  it("settles two different lines with one id the same way on both sides", () => {
    const a = line("evt_x", 1, 0, "-a");
    const b = line("evt_x", 1, 0, "-b");
    expect(mergeJournals(a, b)).toBe(mergeJournals(b, a));
    expect(mergeJournals(a, b)).toBe(a < b ? a : b);
  });

  it("tolerates a byte order mark, CRLF and blank lines", () => {
    const merged = mergeJournals(`\ufeff${line("evt_a", 1).replace("\n", "\r\n")}\n\n`, "");
    expect(merged).toBe(line("evt_a", 1));
  });

  test.prop([journalArb, journalArb])(
    "is symmetric: both devices end with the same bytes",
    (a, b) => {
      expect(mergeJournals(a, b)).toBe(mergeJournals(b, a));
    },
  );

  test.prop([journalArb, journalArb])("loses no event and no other line of either side", (a, b) => {
    const merged = mergeJournals(a, b);
    expect(eventIds(merged)).toEqual([...new Set([...eventIds(a), ...eventIds(b)])].sort());
    const kept = new Set(merged.split("\n"));
    const notEvents = (journal: string) =>
      journal.split("\n").filter((text) => text.trim() !== "" && eventIds(text).length === 0);
    for (const text of [...notEvents(a), ...notEvents(b)]) expect(kept.has(text)).toBe(true);
  });

  test.prop([journalArb, journalArb, journalArb])(
    "is idempotent and associative (three devices converge in any order)",
    (a, b, c) => {
      const ab = mergeJournals(a, b);
      expect(mergeJournals(ab, ab)).toBe(ab);
      expect(mergeJournals(ab, b)).toBe(ab);
      expect(mergeJournals(ab, c)).toBe(mergeJournals(a, mergeJournals(b, c)));
    },
  );
});

describe("isJournalPath", () => {
  it("is the agent's journal folder and nothing else", () => {
    expect(isJournalPath(".daily-do-list/state/journal/threads/thr_a.jsonl")).toBe(true);
    expect(isJournalPath(".daily-do-list/state/journal/approvals.jsonl")).toBe(true);
    expect(isJournalPath("exports/data.jsonl")).toBe(false);
    expect(isJournalPath(".daily-do-list/threads/thr_a.json")).toBe(false);
    expect(isJournalPath(".daily-do-list/state/journal/threads/thr_a.json")).toBe(false);
  });
});
