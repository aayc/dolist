import { describe, expect, it } from "vitest";
import { resolveTaskAnchors } from "./anchors";
import { isEmptyDiff, type TrackedTask, trackTasks } from "./task-tracker";
import { parseTasks } from "./tasks";

function ids() {
  let n = 0;
  return () => `t${++n}`;
}

function track(prev: TrackedTask[], doc: string, idFactory = ids(), now = 1000) {
  return trackTasks(prev, parseTasks(doc), { idFactory, now });
}

describe("trackTasks", () => {
  it("assigns ids to new tasks", () => {
    const { tasks, diff } = track([], "- [ ] a task\n- [ ] another task");
    expect(tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(diff.added).toHaveLength(2);
  });

  it("keeps identity while the user is still typing (prefix extension)", () => {
    const factory = ids();
    const first = track([], "- [ ] Book den", factory);
    const second = track(first.tasks, "- [ ] Book dentist appointment for Tuesday", factory, 2000);
    expect(second.tasks[0]!.id).toBe(first.tasks[0]!.id);
    expect(second.diff.added).toHaveLength(0);
    expect(second.diff.updated).toHaveLength(1);
    expect(second.diff.updated[0]!.changes).toEqual(["text"]);
    expect(second.tasks[0]!.firstSeenAt).toBe(1000);
    expect(second.tasks[0]!.updatedAt).toBe(2000);
  });

  it("keeps identity through typo fixes and small rewrites", () => {
    const factory = ids();
    const first = track([], "- [ ] Email Sarah about the offsite agenda", factory);
    const second = track(first.tasks, "- [ ] Email Sara about offsite agenda + budget", factory);
    expect(second.tasks[0]!.id).toBe(first.tasks[0]!.id);
  });

  it("keeps identity when tasks are reordered", () => {
    const factory = ids();
    const first = track([], "- [ ] alpha task\n- [ ] beta task\n- [ ] gamma task", factory);
    const second = track(
      first.tasks,
      "- [ ] gamma task\n- [ ] alpha task\n- [ ] beta task",
      factory,
    );
    const byText = Object.fromEntries(second.tasks.map((t) => [t.text, t.id]));
    const before = Object.fromEntries(first.tasks.map((t) => [t.text, t.id]));
    expect(byText).toEqual(before);
    expect(isEmptyDiff(second.diff)).toBe(true);
  });

  it("reports status changes separately from text changes", () => {
    const factory = ids();
    const first = track([], "- [ ] pay rent", factory);
    const second = track(first.tasks, "- [x] pay rent", factory);
    expect(second.diff.statusChanged).toHaveLength(1);
    expect(second.diff.updated).toHaveLength(0);
    expect(second.tasks[0]!.status).toBe("done");
  });

  it("detects removals and genuinely new tasks", () => {
    const factory = ids();
    const first = track([], "- [ ] buy milk\n- [ ] renew car registration", factory);
    const second = track(
      first.tasks,
      "- [ ] renew car registration\n- [ ] plan birthday party",
      factory,
    );
    expect(second.diff.removed.map((t) => t.text)).toEqual(["buy milk"]);
    expect(second.diff.added.map((t) => t.text)).toEqual(["plan birthday party"]);
  });

  it("disambiguates duplicate task texts by line proximity", () => {
    const factory = ids();
    const first = track([], "- [ ] call\n- [ ] x y z\n- [ ] call", factory);
    const second = track(
      first.tasks,
      "- [ ] new first\n- [ ] call\n- [ ] x y z\n- [ ] call",
      factory,
    );
    expect(second.tasks[1]!.id).toBe(first.tasks[0]!.id);
    expect(second.tasks[3]!.id).toBe(first.tasks[2]!.id);
    expect(second.diff.added.map((t) => t.text)).toEqual(["new first"]);
  });

  it("detects note changes under a task", () => {
    const factory = ids();
    const first = track([], "- [ ] plan trip", factory);
    const second = track(first.tasks, "- [ ] plan trip\n  - budget $2k", factory);
    expect(second.diff.updated[0]!.changes).toEqual(["notes"]);
  });

  it("links nested tasks to parent ids", () => {
    const { tasks } = track([], "- [ ] parent task\n  - [ ] child task");
    expect(tasks[1]!.parentId).toBe(tasks[0]!.id);
  });
});

describe("resolveTaskAnchors", () => {
  it("re-finds anchors after local edits shift lines", () => {
    const anchors = [
      { taskId: "a", text: "Book dentist", line: 0 },
      { taskId: "b", text: "Renew passport", line: 1 },
    ];
    const doc = "- [ ] New task on top\n- [ ] Book dentist for Tuesday\n\n- [ ] Renew passport";
    const map = resolveTaskAnchors(doc, anchors);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(3);
  });

  it("drops anchors whose task was deleted", () => {
    const map = resolveTaskAnchors("- [ ] something else entirely", [
      { taskId: "a", text: "Book dentist", line: 0 },
    ]);
    expect(map.has("a")).toBe(false);
  });
});
