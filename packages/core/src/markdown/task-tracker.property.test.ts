import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { normalizeText } from "../text";
import { resolveTaskAnchors } from "./anchors";
import { isEmptyDiff, type TaskDiff, type TrackedTask, trackTasks } from "./task-tracker";
import { isBlankTaskText, type ParsedTask, parseTasks } from "./tasks";

// ── Model: a flat-ish to-do list rendered to markdown ────────────────────────────────────────

interface Item {
  text: string;
  status: " " | "x" | "/";
  nested: boolean;
  notes: string[];
}

function render(items: readonly Item[]): string {
  const lines: string[] = [];
  items.forEach((item, i) => {
    const indent = item.nested && i > 0 ? "  " : "";
    lines.push(`${indent}- [${item.status}] ${item.text}`);
    for (const note of item.notes) lines.push(`${indent}  - ${note}`);
  });
  return lines.join("\n");
}

function sequentialIds(): () => string {
  let n = 0;
  return () => `t${++n}`;
}

function track(previous: readonly TrackedTask[], doc: string, idFactory: () => string, now = 1) {
  return trackTasks(previous, parseTasks(doc), { idFactory, now });
}

const WORDS = [
  "call",
  "mom",
  "buy",
  "milk",
  "book",
  "dentist",
  "email",
  "sarah",
  "plan",
  "trip",
  "renew",
  "passport",
  "pay",
  "rent",
  "water",
  "plants",
  "fix",
  "bike",
  "review",
  "pr",
];
const textArb = fc
  .array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 4 })
  .map((words) => words.join(" "));
const statusArb = fc.constantFrom<Item["status"]>(" ", "x", "/");
const itemArb = (text: fc.Arbitrary<string>): fc.Arbitrary<Item> =>
  fc.record({
    text,
    status: statusArb,
    nested: fc.boolean(),
    notes: fc.array(fc.constantFrom<string>("budget $2k", "ask Sam", "before Friday"), {
      maxLength: 1,
    }),
  });
const flat = (text: fc.Arbitrary<string>): fc.Arbitrary<Item> =>
  fc.record({
    text,
    status: statusArb,
    nested: fc.constant(false),
    notes: fc.constant<string[]>([]),
  });

/** Lists whose texts are distinct after normalization. */
const uniqueItemsArb = (min = 1, max = 12) =>
  fc
    .uniqueArray(textArb, { minLength: min, maxLength: max, selector: normalizeText })
    .chain((texts) => fc.tuple(...texts.map((t) => flat(fc.constant(t)))));
const anyItemsArb = fc.array(itemArb(textArb), { minLength: 1, maxLength: 12 });

const idsByText = (tasks: readonly TrackedTask[]) => {
  const out = new Map<string, string[]>();
  for (const t of tasks) {
    const key = normalizeText(t.text);
    out.set(key, [...(out.get(key) ?? []), t.id].sort());
  }
  return out;
};

// ── Invariants of one tracking step ──────────────────────────────────────────────────────────

function checkStep(
  previous: readonly TrackedTask[],
  parsed: readonly ParsedTask[],
  result: { tasks: TrackedTask[]; diff: TaskDiff },
  now: number,
): void {
  const { tasks, diff } = result;
  const previousIds = new Set(previous.map((t) => t.id));
  const previousById = new Map(previous.map((t) => [t.id, t]));
  const ids = tasks.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(tasks).toHaveLength(parsed.length);

  const addedIds = new Set(diff.added.map((t) => t.id));
  const matched = tasks.filter((t) => previousIds.has(t.id));
  for (const id of addedIds) expect(previousIds.has(id)).toBe(false);
  expect(diff.added.length + matched.length).toBe(parsed.length);
  expect(diff.removed.length + matched.length).toBe(previous.length);
  const current = new Set(ids);
  for (const gone of diff.removed) {
    expect(previousIds.has(gone.id)).toBe(true);
    expect(current.has(gone.id)).toBe(false);
  }

  const idByLine = new Map(tasks.map((t) => [t.line, t.id]));
  tasks.forEach((task, i) => {
    const p = parsed[i]!;
    expect(task).toMatchObject({ text: p.text, status: p.status, line: p.line, depth: p.depth });
    expect(task.notes).toEqual(p.notes);
    expect(task.parentId).toBe(p.parentLine === null ? null : idByLine.get(p.parentLine));
    const prev = previousById.get(task.id);
    if (!prev) {
      expect(addedIds.has(task.id)).toBe(true);
      expect(task.firstSeenAt).toBe(now);
      expect(task.updatedAt).toBe(now);
      return;
    }
    const textChanged = prev.text !== task.text;
    const notesChanged = JSON.stringify(prev.notes) !== JSON.stringify(task.notes);
    const statusChanged = prev.status !== task.status;
    const updated = diff.updated.find((u) => u.task.id === task.id);
    expect(updated?.changes ?? []).toEqual([
      ...(textChanged ? ["text"] : []),
      ...(notesChanged ? ["notes"] : []),
    ]);
    expect(diff.statusChanged.some((s) => s.task.id === task.id)).toBe(statusChanged);
    expect(task.firstSeenAt).toBe(prev.firstSeenAt);
    expect(task.updatedAt).toBe(
      textChanged || notesChanged || statusChanged ? now : prev.updatedAt,
    );
    expect(task.firstSeenAt).toBeLessThanOrEqual(task.updatedAt);
  });
  for (const u of [...diff.updated, ...diff.statusChanged]) {
    expect(previousById.get(u.previous.id)).toBe(u.previous);
    expect(u.task.id).toBe(u.previous.id);
  }
}

// ── Properties ───────────────────────────────────────────────────────────────────────────────

describe("trackTasks identity properties", () => {
  test.prop([anyItemsArb])("an unchanged document keeps every id and reports nothing", (items) => {
    const ids = sequentialIds();
    const doc = render(items);
    const first = track([], doc, ids, 1_000);
    const again = track(first.tasks, doc, ids, 2_000);
    expect(again.tasks).toEqual(first.tasks);
    expect(isEmptyDiff(again.diff)).toBe(true);
  });

  const permutedArb = uniqueItemsArb(2).chain((items) =>
    fc.tuple(
      fc.constant(items),
      fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length }),
    ),
  );

  test.prop([permutedArb])(
    "reordering tasks keeps every id and reports nothing",
    ([items, order]) => {
      const ids = sequentialIds();
      const first = track([], render(items), ids);
      const second = track(first.tasks, render(order), ids);
      expect(idsByText(second.tasks)).toEqual(idsByText(first.tasks));
      expect(isEmptyDiff(second.diff)).toBe(true);
    },
  );

  test.prop([fc.array(flat(textArb), { minLength: 2, maxLength: 10 }), fc.nat()])(
    "reordering duplicates keeps each text's ids and adds or removes nothing",
    (items, rotation) => {
      const ids = sequentialIds();
      const first = track([], render(items), ids);
      const k = rotation % items.length;
      const second = track(first.tasks, render([...items.slice(k), ...items.slice(0, k)]), ids);
      expect(idsByText(second.tasks)).toEqual(idsByText(first.tasks));
      expect(second.diff.added).toEqual([]);
      expect(second.diff.removed).toEqual([]);
    },
  );

  test.prop([uniqueItemsArb(0), textArb, fc.nat(), statusArb])(
    "inserting a task never changes existing ids (unique texts)",
    (items, text, at, status) => {
      fc.pre(!items.some((i) => normalizeText(i.text) === normalizeText(text)));
      const ids = sequentialIds();
      const first = track([], render(items), ids);
      const next = [...items];
      next.splice(at % (items.length + 1), 0, { text, status, nested: false, notes: [] });
      const second = track(first.tasks, render(next), ids);
      checkStep(first.tasks, parseTasks(render(next)), second, 1);
      for (const [key, before] of idsByText(first.tasks)) {
        expect(idsByText(second.tasks).get(key)).toEqual(before);
      }
      expect(second.diff.added.map((t) => t.text)).toEqual([text]);
      expect(second.diff.removed).toEqual([]);
    },
  );

  test.prop([fc.array(flat(textArb), { maxLength: 10 }), textArb, fc.nat()])(
    "inserting a task (duplicates allowed) keeps every existing id",
    (items, text, at) => {
      const ids = sequentialIds();
      const first = track([], render(items), ids);
      const next = [...items];
      next.splice(at % (items.length + 1), 0, { text, status: " ", nested: false, notes: [] });
      const second = track(first.tasks, render(next), ids);
      const kept = new Set(second.tasks.map((t) => t.id));
      for (const t of first.tasks) expect(kept.has(t.id)).toBe(true);
      expect(second.diff.added).toHaveLength(1);
      expect(second.diff.removed).toEqual([]);
    },
  );

  test.prop([uniqueItemsArb(1), fc.nat()])(
    "deleting a task removes exactly its id (unique texts)",
    (items, at) => {
      const ids = sequentialIds();
      const first = track([], render(items), ids);
      const index = at % items.length;
      const next = items.filter((_, i) => i !== index);
      const second = track(first.tasks, render(next), ids);
      expect(second.diff.removed.map((t) => t.id)).toEqual([first.tasks[index]!.id]);
      expect(second.diff.added).toEqual([]);
      const before = idsByText(first.tasks);
      for (const [key, idsAfter] of idsByText(second.tasks))
        expect(before.get(key)).toEqual(idsAfter);
    },
  );

  test.prop([fc.array(flat(textArb), { minLength: 1, maxLength: 10 }), fc.nat()])(
    "deleting a task (duplicates allowed) removes one id with the deleted text",
    (items, at) => {
      const ids = sequentialIds();
      const first = track([], render(items), ids);
      const index = at % items.length;
      const second = track(first.tasks, render(items.filter((_, i) => i !== index)), ids);
      expect(second.diff.added).toEqual([]);
      expect(second.diff.removed).toHaveLength(1);
      expect(normalizeText(second.diff.removed[0]!.text)).toBe(normalizeText(items[index]!.text));
    },
  );

  test.prop([
    uniqueItemsArb(0, 8),
    fc.nat(),
    fc.oneof(textArb, fc.string({ unit: "grapheme-ascii", minLength: 2, maxLength: 24 })),
    fc.boolean(),
  ])(
    "typing a task character by character keeps one id, and never steals another task's",
    (items, at, typed, copyExisting) => {
      const target =
        copyExisting && items.length > 0 ? items[at % items.length]!.text : typed.trim();
      fc.pre(!isBlankTaskText(target));
      const ids = sequentialIds();
      let state = track([], render(items), ids).tasks;
      const existing = new Map(state.map((t) => [t.line, t.id]));
      const position = at % (items.length + 1);
      let typedId: string | undefined;
      for (let length = 1; length <= target.length; length++) {
        const partial = target.slice(0, length);
        const next = [...items];
        next.splice(position, 0, { text: partial, status: " ", nested: false, notes: [] });
        state = track(state, render(next), ids).tasks;
        const mine = state.find((t) => t.line === position)!;
        for (const [line, id] of existing) {
          expect(state.find((t) => t.line === (line < position ? line : line + 1))?.id).toBe(id);
        }
        if (isBlankTaskText(mine.text)) continue;
        typedId ??= mine.id;
        expect(mine.id, `after typing ${JSON.stringify(partial)}`).toBe(typedId);
      }
    },
  );

  test.prop([uniqueItemsArb(1), fc.array(fc.boolean(), { minLength: 12, maxLength: 12 })])(
    "status-only changes are reported as status changes, never as edits",
    (items, flips) => {
      const ids = sequentialIds();
      const first = track([], render(items), ids, 1);
      const next = items.map((item, i) =>
        flips[i]
          ? { ...item, status: item.status === "x" ? (" " as const) : ("x" as const) }
          : item,
      );
      const second = track(first.tasks, render(next), ids, 2);
      expect(second.tasks.map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
      expect(second.diff.updated).toEqual([]);
      expect(second.diff.statusChanged.map((s) => s.task.line).sort((a, b) => a - b)).toEqual(
        items.flatMap((_, i) => (flips[i] ? [i] : [])),
      );
      for (const s of second.diff.statusChanged) expect(s.task.updatedAt).toBe(2);
    },
  );

  test.prop([uniqueItemsArb(1), fc.nat()])(
    "adding a note under a task reports a notes change for that task only",
    (items, at) => {
      const ids = sequentialIds();
      const first = track([], render(items), ids);
      const index = at % items.length;
      const next = items.map((item, i) =>
        i === index ? { ...item, notes: ["new detail"] } : item,
      );
      const second = track(first.tasks, render(next), ids);
      expect(second.diff.updated.map((u) => [u.task.id, u.changes])).toEqual([
        [first.tasks[index]!.id, ["notes"]],
      ]);
    },
  );
});

// ── Random edit sequences ────────────────────────────────────────────────────────────────────

type Edit =
  | { kind: "insert"; at: number; item: Item }
  | { kind: "delete"; at: number }
  | { kind: "retext"; at: number; text: string }
  | { kind: "type"; at: number; suffix: string }
  | { kind: "backspace"; at: number }
  | { kind: "toggle"; at: number }
  | { kind: "move"; from: number; to: number }
  | { kind: "note"; at: number }
  | { kind: "nest"; at: number };

const editArb: fc.Arbitrary<Edit> = fc.oneof(
  fc.record({ kind: fc.constant("insert" as const), at: fc.nat(), item: itemArb(textArb) }),
  fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("retext" as const), at: fc.nat(), text: textArb }),
  fc.record({
    kind: fc.constant("type" as const),
    at: fc.nat(),
    suffix: fc.constantFrom(" ", "s", " today", "!", " [[Daily/2026-09-24]]"),
  }),
  fc.record({ kind: fc.constant("backspace" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("toggle" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("move" as const), from: fc.nat(), to: fc.nat() }),
  fc.record({ kind: fc.constant("note" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("nest" as const), at: fc.nat() }),
);

function applyEdit(items: Item[], edit: Edit): Item[] {
  const next = items.map((item) => ({ ...item, notes: [...item.notes] }));
  const pick = (n: number) => n % Math.max(1, next.length);
  switch (edit.kind) {
    case "insert":
      next.splice(edit.at % (next.length + 1), 0, edit.item);
      return next;
    case "delete":
      if (next.length > 0) next.splice(pick(edit.at), 1);
      return next;
    case "retext":
      if (next.length > 0) next[pick(edit.at)]!.text = edit.text;
      return next;
    case "type":
      if (next.length > 0) next[pick(edit.at)]!.text += edit.suffix;
      return next;
    case "backspace":
      if (next.length > 0) next[pick(edit.at)]!.text = next[pick(edit.at)]!.text.slice(0, -1);
      return next;
    case "toggle":
      if (next.length > 0) {
        const item = next[pick(edit.at)]!;
        item.status = item.status === "x" ? " " : "x";
      }
      return next;
    case "move":
      if (next.length > 0) {
        const [moved] = next.splice(pick(edit.from), 1);
        next.splice(edit.to % (next.length + 1), 0, moved!);
      }
      return next;
    case "note":
      if (next.length > 0) next[pick(edit.at)]!.notes.push("follow-up");
      return next;
    case "nest":
      if (next.length > 0) next[pick(edit.at)]!.nested = !next[pick(edit.at)]!.nested;
      return next;
  }
}

describe("trackTasks under random edit sequences", () => {
  test.prop([
    anyItemsArb,
    fc.array(fc.array(editArb, { minLength: 1, maxLength: 3 }), { maxLength: 12 }),
  ])("keeps ids unique, the diff balanced and timestamps monotonic", (initial, steps) => {
    const ids = sequentialIds();
    let items = initial;
    let now = 1_000;
    let state = track([], render(items), ids, now).tasks;
    for (const batch of steps) {
      for (const edit of batch) items = applyEdit(items, edit);
      now += 1_000;
      const parsed = parseTasks(render(items));
      const result = trackTasks(state, parsed, { idFactory: ids, now });
      checkStep(state, parsed, result, now);
      state = result.tasks;
    }
  });

  test.prop([anyItemsArb, fc.array(editArb, { minLength: 1, maxLength: 6 })])(
    "resolveTaskAnchors agrees with trackTasks when it has every anchor",
    (initial, edits) => {
      const ids = sequentialIds();
      const state = track([], render(initial), ids).tasks;
      const doc = render(edits.reduce(applyEdit, initial));
      const expected = new Map(
        track(state, doc, ids)
          .tasks.filter((t) => state.some((s) => s.id === t.id))
          .map((t) => [t.id, t.line]),
      );
      const anchors = state.map((t) => ({ taskId: t.id, text: t.text, line: t.line }));
      expect(resolveTaskAnchors(doc, anchors)).toEqual(expected);
    },
  );

  test.prop([
    anyItemsArb,
    fc.array(editArb, { maxLength: 6 }),
    fc.array(fc.boolean(), { minLength: 12 }),
  ])(
    "resolveTaskAnchors with a subset maps anchors to distinct task lines",
    (initial, edits, keep) => {
      const ids = sequentialIds();
      const state = track([], render(initial), ids).tasks;
      const doc = render(edits.reduce(applyEdit, initial));
      const parsed = parseTasks(doc);
      const anchors = state
        .filter((_, i) => keep[i % keep.length])
        .map((t) => ({ taskId: t.id, text: t.text, line: t.line }));
      const resolved = resolveTaskAnchors(doc, anchors);
      const lines = [...resolved.values()];
      expect(new Set(lines).size).toBe(lines.length);
      const taskLines = new Set(parsed.map((t) => t.line));
      for (const line of lines) expect(taskLines.has(line)).toBe(true);
      for (const [id] of resolved) expect(anchors.some((a) => a.taskId === id)).toBe(true);
      // An anchor whose text now occurs exactly once (and in no other anchor) resolves to it.
      for (const anchor of anchors) {
        const key = normalizeText(anchor.text);
        const hits = parsed.filter((t) => normalizeText(t.text) === key);
        const rivals = anchors.filter((a) => normalizeText(a.text) === key);
        if (hits.length === 1 && rivals.length === 1) {
          expect(resolved.get(anchor.taskId)).toBe(hits[0]!.line);
        }
      }
    },
  );
});

describe("duplicate texts (regressions)", () => {
  it("typing a duplicate above an existing task does not steal its id", () => {
    const ids = sequentialIds();
    let state = track([], "- [ ] call mom", ids).tasks;
    const original = state[0]!.id;
    for (const partial of ["c", "ca", "cal", "call mo", "call mom"]) {
      state = track(state, `- [ ] ${partial}\n- [ ] call mom`, ids).tasks;
    }
    expect(state.find((t) => t.id === original)?.line).toBe(1);
    expect(state[0]!.id).not.toBe(original);
  });

  it("deleting one of two duplicates removes the one that was deleted", () => {
    const ids = sequentialIds();
    const first = track([], "- [ ] call\n- [ ] x marks the spot\n- [ ] call", ids);
    const second = track(first.tasks, "- [ ] x marks the spot\n- [ ] call", ids);
    expect(second.diff.removed.map((t) => t.id)).toEqual([first.tasks[0]!.id]);
    expect(second.tasks[1]!.id).toBe(first.tasks[2]!.id);
  });

  it("inserting a task above a run of duplicates shifts them in order", () => {
    const ids = sequentialIds();
    const first = track([], "- [ ] call\n- [ ] call", ids);
    const second = track(first.tasks, "- [ ] brand new\n- [ ] call\n- [ ] call", ids);
    expect(second.tasks.slice(1).map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
  });

  it("duplicates are matched by position, not by checkbox state", () => {
    // Ambiguous by text alone; the tracker keeps ids on their lines and reports status changes.
    const ids = sequentialIds();
    const first = track([], "- [x] call\n- [ ] call", ids);
    const second = track(first.tasks, "- [ ] call\n- [x] call", ids);
    expect(second.tasks.map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
    expect(second.diff.statusChanged).toHaveLength(2);
  });
});

describe("trackTasks performance guard", () => {
  const note = (n: number, label: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => `- [ ] ${label(i)}`).join("\n");
  const base = note(2_000, (i) => `follow up with vendor ${i} about invoice ${i * 7}`);
  const tracked = trackTasks([], parseTasks(base), { now: 0 }).tasks;

  it.each([
    ["a full rewrite", note(2_000, (i) => `completely different item ${i} for project ${i % 13}`)],
    [
      "half the tasks edited",
      note(2_000, (i) => `follow up with vendor ${i} about invoice ${i * 7}${i % 2 ? "!" : ""}`),
    ],
    ["a block moved and 100 tasks inserted", `${note(100, (i) => `new ${i}`)}\n${base}`],
    ["every task duplicated", note(2_000, () => "same text")],
  ])("tracks a 2k-task note after %s quickly", (_name, doc) => {
    const parsed = parseTasks(doc);
    const started = performance.now();
    const { tasks } = trackTasks(tracked, parsed, { now: 1 });
    expect(performance.now() - started).toBeLessThan(300);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
  });

  it("tracks a note of 2k identical tasks after inserting more of them quickly", () => {
    const same = note(2_000, () => "same text");
    const state = trackTasks([], parseTasks(same), { now: 0 }).tasks;
    const parsed = parseTasks(`${note(10, () => "same text")}\n${same}`);
    const started = performance.now();
    const { diff } = trackTasks(state, parsed, { now: 1 });
    expect(performance.now() - started).toBeLessThan(300);
    expect(diff.added).toHaveLength(10);
    expect(diff.removed).toEqual([]);
  });

  test.prop([fc.array(editArb, { minLength: 1, maxLength: 40 })], { numRuns: 10 })(
    "random edits to a 2k-task note track in well under a frame budget",
    (edits) => {
      const items: Item[] = Array.from({ length: 2_000 }, (_, i) => ({
        text: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}`,
        status: " ",
        nested: false,
        notes: [],
      }));
      const ids = sequentialIds();
      const state = track([], render(items), ids).tasks;
      const parsed = parseTasks(render(edits.reduce(applyEdit, items)));
      const started = performance.now();
      trackTasks(state, parsed, { idFactory: ids, now: 2 });
      expect(performance.now() - started).toBeLessThan(100);
    },
  );
});
