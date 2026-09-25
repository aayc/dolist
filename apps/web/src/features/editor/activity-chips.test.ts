import {
  ORCHESTRATOR_THREAD_ID,
  type OrchestratorActivity,
  type OrchestratorOutcome,
  type OrchestratorTrigger,
} from "@ddl/core";
import { describe, expect, it } from "vitest";
import {
  type ActivityView,
  CHIP_TIMING,
  type ChipEntry,
  chipLook,
  chipTarget,
  EMPTY_ACTIVITY,
  expireChips,
  nextChipChange,
  noteIndicator,
  placeChips,
  reduceActivity,
  statusIndicator,
} from "./activity-chips";

const NOTE = "Daily/2026-09-25.md";
const PLUMBER = { line: 2, text: "find a plumber for Saturday" };
const QUESTION = { line: 4, text: "Is the pharmacy open on Sunday?" };

function note(
  lines: Array<{ line: number; text: string }>,
  summary = "your note",
): OrchestratorTrigger {
  return { kind: "note", notePath: NOTE, lines, summary };
}

function run(events: OrchestratorActivity[], start = 1_000): ActivityView {
  let keys = 0;
  let state = EMPTY_ACTIVITY;
  events.forEach((event, i) => {
    state = reduceActivity(state, event, start + i * 100, () => `k${++keys}`);
  });
  return state;
}

const shape = (state: ActivityView) =>
  state.chips.map((c) => ({ key: c.key, line: c.line, phase: c.phase, kind: c.outcome?.kind }));

describe("reduceActivity", () => {
  it("puts a dot on each noticed line, and a turn takes the dot over on the same chip", () => {
    const noticed = run([{ phase: "noticed", trigger: note([PLUMBER]) }]);
    expect(shape(noticed)).toEqual([{ key: "k1", line: 2, phase: "noticed", kind: undefined }]);
    expect(noticed.turn).toBeNull();
    const reading = run([
      { phase: "noticed", trigger: note([PLUMBER]) },
      { phase: "reading", turnId: "msg_1", trigger: note([PLUMBER]) },
    ]);
    expect(shape(reading)).toEqual([{ key: "k1", line: 2, phase: "reading", kind: undefined }]);
    expect(reading.turn).toMatchObject({ phase: "reading", turnId: "msg_1" });
  });

  it("keeps a dot's chip while its line is still typed, and drops dots that aren't noticed any more", () => {
    const state = run([
      { phase: "noticed", trigger: note([{ line: 2, text: "find a plu" }]) },
      { phase: "noticed", trigger: note([PLUMBER, QUESTION]) },
      { phase: "noticed", trigger: note([QUESTION]) },
    ]);
    expect(shape(state)).toEqual([{ key: "k2", line: 4, phase: "noticed", kind: undefined }]);
  });

  it("ends a turn with its outcome, fading later (nothing to do sooner)", () => {
    const outcome: OrchestratorOutcome = { kind: "delegated", count: 1, threadId: "thr_1" };
    const state = run([
      { phase: "reading", turnId: "msg_1", trigger: note([PLUMBER]) },
      { phase: "thinking", turnId: "msg_1", trigger: note([PLUMBER]) },
      { phase: "acting", turnId: "msg_1", trigger: note([PLUMBER]) },
      { phase: "idle", turnId: "msg_1", trigger: note([PLUMBER]), outcome },
    ]);
    expect(state.turn).toBeNull();
    expect(state.chips[0]).toMatchObject({
      phase: "idle",
      outcome,
      fadeAt: 1_300 + CHIP_TIMING.outcomeMs,
      removeAt: 1_300 + CHIP_TIMING.outcomeMs + CHIP_TIMING.fadeMs,
    });
    const nothing = run([
      { phase: "reading", turnId: "msg_1", trigger: note([PLUMBER]) },
      { phase: "idle", turnId: "msg_1", trigger: note([PLUMBER]), outcome: { kind: "no_action" } },
    ]);
    expect(nothing.chips[0]?.fadeAt).toBe(1_100 + CHIP_TIMING.nothingMs);
  });

  it("removes a failed or stopped turn's chips", () => {
    const state = run([
      { phase: "noticed", trigger: note([QUESTION]) },
      { phase: "reading", turnId: "msg_1", trigger: note([PLUMBER]) },
      { phase: "idle", turnId: "msg_1", trigger: note([PLUMBER]) },
    ]);
    expect(shape(state)).toEqual([{ key: "k1", line: 4, phase: "noticed", kind: undefined }]);
  });

  it("withdraws noticed lines, and a bare idle clears whatever was in progress", () => {
    const withdrawn = run([
      { phase: "noticed", trigger: note([PLUMBER, QUESTION]) },
      { phase: "idle", trigger: note([]) },
    ]);
    expect(withdrawn.chips).toEqual([]);
    const reset = run([
      { phase: "reading", turnId: "msg_1", trigger: note([PLUMBER]) },
      { phase: "idle", turnId: "msg_0", trigger: note([QUESTION]), outcome: { kind: "replied" } },
      { phase: "idle" },
    ]);
    expect(reset.turn).toBeNull();
    expect(shape(reset)).toEqual([{ key: "k2", line: 4, phase: "idle", kind: "replied" }]);
  });

  it("follows a turn that isn't about lines (a message) in the indicators only", () => {
    const state = run([
      { phase: "thinking", turnId: "msg_1", trigger: { kind: "message", summary: "your message" } },
    ]);
    expect(state.chips).toEqual([]);
    expect(state.turn?.phase).toBe("thinking");
  });

  it("expires chips and tells when the next one changes", () => {
    const state = run([
      { phase: "reading", turnId: "msg_1", trigger: note([PLUMBER]) },
      { phase: "idle", turnId: "msg_1", trigger: note([PLUMBER]), outcome: { kind: "replied" } },
    ]);
    const fadeAt = state.chips[0]!.fadeAt!;
    expect(nextChipChange(state, 1_100)).toBe(fadeAt);
    expect(nextChipChange(state, fadeAt)).toBe(fadeAt + CHIP_TIMING.fadeMs);
    expect(expireChips(state, fadeAt).chips).toHaveLength(1);
    expect(expireChips(state, fadeAt + CHIP_TIMING.fadeMs).chips).toEqual([]);
  });
});

describe("chip wording", () => {
  const entry = (patch: Partial<ChipEntry>): ChipEntry => ({
    key: "k",
    notePath: NOTE,
    line: 0,
    text: "x",
    phase: "idle",
    ...patch,
  });

  it("says what it's doing, in the words the Mac app uses too", () => {
    const look = (patch: Partial<ChipEntry>) => chipLook(entry(patch), 0);
    expect(look({ phase: "noticed" })).toMatchObject({ label: "", tone: "quiet", pulse: true });
    expect(look({ phase: "reading" }).label).toBe("Orchestrator is looking…");
    expect(look({ phase: "thinking" }).label).toBe("Orchestrator is looking…");
    expect(look({ phase: "acting" }).label).toBe("Working…");
    const labels = (
      [
        ["tasks_added", 1],
        ["tasks_added", 3],
        ["replied", 1],
        ["delegated", 1],
        ["delegated", 2],
        ["routine_created", 1],
        ["asked_approval", 1],
        ["note_edited", 1],
        ["no_action", undefined],
      ] as const
    ).map(
      ([kind, count]) =>
        look({ outcome: { kind, ...(count !== undefined ? { count } : {}) } }).label,
    );
    expect(labels).toEqual([
      "Added a task ↗",
      "Added 3 tasks ↗",
      "Replied ↗",
      "Started a task ↗",
      "Started 2 tasks ↗",
      "Made a routine ↗",
      "Needs your approval ↗",
      "Edited the note ↗",
      "Nothing to do",
    ]);
  });

  it("puts the outcome's line in the tooltip, and is loud only when it needs you", () => {
    expect(
      chipLook(entry({ outcome: { kind: "delegated", text: "Find a plumber" } }), 0),
    ).toMatchObject({
      tooltip: "Started a task: Find a plumber",
      tone: "quiet",
      kind: "outcome",
    });
    const waiting = entry({
      phase: "acting",
      outcome: { kind: "asked_approval", threadId: ORCHESTRATOR_THREAD_ID },
    });
    expect(chipLook(waiting, 0)).toMatchObject({
      label: "Needs your approval ↗",
      tone: "needs-you",
      kind: "needs-you",
    });
  });

  it("fades once its time is up", () => {
    const fading = entry({ outcome: { kind: "replied" }, fadeAt: 500, removeAt: 1_100 });
    expect(chipLook(fading, 499).fading).toBeUndefined();
    expect(chipLook(fading, 500).fading).toBe(true);
  });

  it("opens the outcome's thread, else the orchestrator's chat at its turn", () => {
    expect(
      chipTarget(entry({ turnId: "msg_1", outcome: { kind: "replied", threadId: "thr_1" } })),
    ).toEqual({
      threadId: "thr_1",
    });
    expect(
      chipTarget(
        entry({ turnId: "msg_1", outcome: { kind: "replied", threadId: ORCHESTRATOR_THREAD_ID } }),
      ),
    ).toEqual({ turnId: "msg_1" });
    expect(chipTarget(entry({ phase: "noticed" }))).toEqual({ turnId: null });
  });
});

describe("placeChips", () => {
  const LINES = ["# Thursday", "Groceries", PLUMBER.text, "- [ ] email Sam", QUESTION.text];
  const entries = (list: Array<Partial<ChipEntry> & { line: number; text: string }>): ChipEntry[] =>
    list.map((e, i) => ({ key: `k${i}`, notePath: NOTE, phase: "reading", ...e }));

  it("puts chips on their lines, skipping task lines", () => {
    const placed = placeChips(
      entries([PLUMBER, { line: 3, text: "email Sam" }, QUESTION]),
      LINES,
      new Map(),
      0,
    );
    expect(placed.map((c) => [c.id, c.line])).toEqual([
      ["k0", 2],
      ["k2", 4],
    ]);
  });

  it("finds a line that moved or is still being typed, and drops one edited beyond recognition", () => {
    const moved = ["Milk", "Eggs", ...LINES];
    expect(placeChips(entries([PLUMBER]), moved, new Map(), 0).map((c) => c.line)).toEqual([4]);
    const typed = [...LINES];
    typed[2] = `${PLUMBER.text} morning, near home`;
    expect(placeChips(entries([PLUMBER]), typed, new Map(), 0).map((c) => c.line)).toEqual([2]);
    const rewritten = [...LINES];
    rewritten[2] = "Call mom about the weekend";
    expect(placeChips(entries([PLUMBER]), rewritten, new Map(), 0)).toEqual([]);
  });

  it("prefers where the editor has moved the chip", () => {
    const twice = [...LINES, PLUMBER.text];
    const mapped = new Map([["k0", 5]]);
    expect(placeChips(entries([PLUMBER]), twice, mapped, 0).map((c) => c.line)).toEqual([5]);
  });
});

describe("indicators", () => {
  const turn = (
    phase: OrchestratorActivity["phase"],
    trigger: OrchestratorTrigger,
  ): OrchestratorActivity => ({
    phase,
    turnId: "msg_1",
    trigger,
  });

  it("shows the turn in the note header while it's about the open note", () => {
    expect(noteIndicator(turn("reading", note([PLUMBER])), NOTE)).toBe(
      "Orchestrator: reading this note…",
    );
    expect(noteIndicator(turn("thinking", note([PLUMBER])), NOTE)).toBe("Orchestrator: thinking…");
    expect(noteIndicator(turn("acting", note([PLUMBER])), NOTE)).toBe("Orchestrator: working…");
    expect(noteIndicator(turn("acting", note([PLUMBER])), "Ideas.md")).toBeNull();
    expect(noteIndicator(null, NOTE)).toBeNull();
  });

  it("shows what it works on elsewhere in the status bar", () => {
    const yesterday = {
      kind: "task",
      notePath: "Daily/2026-09-24.md",
      summary: "2 tasks",
    } as const;
    expect(statusIndicator(turn("acting", yesterday), NOTE)).toBe(
      "Orchestrator: working on 2026-09-24",
    );
    expect(
      statusIndicator(turn("thinking", { kind: "message", summary: "your message" }), NOTE),
    ).toBe("Orchestrator: working on your message");
    expect(statusIndicator(turn("thinking", note([PLUMBER])), NOTE)).toBeNull();
  });
});
