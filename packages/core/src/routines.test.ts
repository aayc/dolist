import { describe, expect, it } from "vitest";
import { parseSchedule } from "./routine-schedule";
import {
  isRoutinePath,
  parseRoutineFile,
  ROUTINE_TEMPLATES,
  renderRoutineFile,
  routineIdForPath,
  routineNameFromPath,
  routineNameProblem,
  updateRoutineFile,
} from "./routines";

const SPEC_EXAMPLE = [
  "---",
  "schedule: every weekday at 7:30      # natural language, local time",
  "notify: when changed                 # always | when changed | never (default: always)",
  "uses: [web, connectors]              # optional capability hints; otherwise triaged like a task",
  "paused: false                        # optional",
  "---",
  "Brief me for the day: my calendar, SF weather, what I didn't finish yesterday, and anything new",
  "from my news sources. Under 10 lines.",
  "",
].join("\n");

describe("parseRoutineFile", () => {
  it("reads the documented example, comments included", () => {
    const file = parseRoutineFile(SPEC_EXAMPLE);
    expect(file).toMatchObject({
      schedule: "every weekday at 7:30",
      notify: "when_changed",
      uses: ["web", "connectors"],
      paused: false,
      problems: [],
    });
    expect(file.parsedSchedule).toEqual({ kind: "weekly", days: [1, 2, 3, 4, 5], times: [450] });
    expect(file.instructions).toMatch(/^Brief me for the day: .*Under 10 lines\.$/s);
  });

  it("defaults notify to always, uses to none and paused to false", () => {
    const file = parseRoutineFile("---\nschedule: every day at 8\n---\nSay hi.");
    expect(file).toMatchObject({ notify: "always", uses: [], paused: false, problems: [] });
  });

  it("accepts quoted values, block lists, CRLF and a BOM", () => {
    const file = parseRoutineFile(
      "\uFEFF---\r\nschedule: \"every hour\"\r\nnotify: 'never'\r\nuses:\r\n  - web\r\n  - files\r\npaused: yes\r\ntags: [routine]\r\n---\r\nCheck things.\r\n",
    );
    expect(file).toMatchObject({
      schedule: "every hour",
      notify: "never",
      uses: ["web", "files"],
      paused: true,
      instructions: "Check things.",
      problems: [],
    });
  });

  it.each([
    ["no frontmatter", "Just instructions.", /Add a frontmatter block/],
    ["no schedule", "---\nnotify: always\n---\nDo it.", /Add a schedule/],
    ["an unreadable schedule", "---\nschedule: whenever\n---\nDo it.", /Couldn't read “whenever”/],
    ["an unknown notify", "---\nschedule: hourly\nnotify: loudly\n---\nDo it.", /notify must be/],
    [
      "an unknown capability",
      "---\nschedule: hourly\nuses: [web, teleport]\n---\nDo it.",
      /“teleport” isn't a capability/,
    ],
    [
      "a bad paused",
      "---\nschedule: hourly\npaused: maybe\n---\nDo it.",
      /paused must be true or false/,
    ],
    ["no instructions", "---\nschedule: hourly\n---\n\n", /Write what the routine should do/],
    [
      "a stray line",
      "---\nschedule: hourly\nnot yaml\n---\nDo it.",
      /Couldn't read the frontmatter line/,
    ],
  ])("reports %s, never throws", (_label, content, problem) => {
    const file = parseRoutineFile(content);
    expect(file.problems.join("\n")).toMatch(problem);
  });

  it("puts the schedule problem first", () => {
    const file = parseRoutineFile("---\nschedule: whenever\nnotify: loudly\n---\n");
    expect(file.problems[0]).toMatch(/whenever/);
    expect(file.problems).toHaveLength(3);
  });

  it("survives arbitrary text", () => {
    for (const content of [
      "",
      "---",
      "---\n---",
      "---\n: x\n---",
      "\u0000",
      "---\nschedule:\n---",
    ]) {
      expect(() => parseRoutineFile(content)).not.toThrow();
    }
  });
});

describe("renderRoutineFile / updateRoutineFile", () => {
  it("renders a file that reads back the same", () => {
    const content = renderRoutineFile({
      schedule: "every weekday at 7:30",
      notify: "when_changed",
      uses: ["web"],
      instructions: "  Brief me.  ",
    });
    expect(content).toBe(
      "---\nschedule: every weekday at 7:30\nnotify: when changed\nuses: [web]\n---\nBrief me.\n",
    );
    expect(parseRoutineFile(content)).toMatchObject({
      schedule: "every weekday at 7:30",
      notify: "when_changed",
      uses: ["web"],
      paused: false,
      instructions: "Brief me.",
      problems: [],
    });
  });

  it("quotes values YAML would misread", () => {
    const content = renderRoutineFile({ schedule: "every day at 7:30 # soon", instructions: "x" });
    expect(content).toContain('schedule: "every day at 7:30 # soon"');
    expect(parseRoutineFile(content).schedule).toBe("every day at 7:30 # soon");
  });

  it("changes only what it's asked to, keeping comments, other keys and the body", () => {
    const updated = updateRoutineFile(SPEC_EXAMPLE, { paused: true, schedule: "every day at 8" });
    expect(updated.split("\n").slice(0, 6)).toEqual([
      "---",
      "schedule: every day at 8",
      "notify: when changed                 # always | when changed | never (default: always)",
      "uses: [web, connectors]              # optional capability hints; otherwise triaged like a task",
      "paused: true",
      "---",
    ]);
    expect(updated.endsWith("from my news sources. Under 10 lines.\n")).toBe(true);
  });

  it("adds missing keys, replaces block lists and the instructions", () => {
    const content = "---\nschedule: hourly\nuses:\n  - web\n  - files\n---\nOld.\n";
    const updated = updateRoutineFile(content, {
      uses: ["connectors"],
      paused: true,
      instructions: "New.",
    });
    expect(updated).toBe("---\nschedule: hourly\nuses: [connectors]\npaused: true\n---\nNew.\n");
  });

  it("adds a frontmatter block to a file without one", () => {
    expect(updateRoutineFile("Do things.", { schedule: "hourly" })).toBe(
      "---\nschedule: hourly\n---\nDo things.",
    );
  });
});

describe("paths, ids and names", () => {
  it("recognizes routine files: direct, visible markdown children of Routines/", () => {
    expect(isRoutinePath("Routines/Morning briefing.md")).toBe(true);
    expect(isRoutinePath("Routines/Deep/Nested.md")).toBe(false);
    expect(isRoutinePath("Routines/.hidden.md")).toBe(false);
    expect(isRoutinePath("Routines/notes.txt")).toBe(false);
    expect(isRoutinePath("routines/lower.md")).toBe(false);
    expect(isRoutinePath("Daily/2026-09-25.md")).toBe(false);
    expect(routineNameFromPath("Routines/Morning briefing.md")).toBe("Morning briefing");
  });

  it("derives a stable, URL-safe id from the path", () => {
    const id = routineIdForPath("Routines/Morning briefing.md");
    expect(id).toBe(routineIdForPath("Routines/Morning briefing.md"));
    expect(id).toMatch(/^rtn_[0-9a-f]{14}$/);
    expect(id).not.toBe(routineIdForPath("Routines/News digest.md"));
  });

  it("validates names like file names", () => {
    expect(routineNameProblem("Morning briefing")).toBeNull();
    expect(routineNameProblem("Café ☕ digest")).toBeNull();
    for (const bad of ["", " padded", "a/b", "what?", "[x]", ".hidden", "x".repeat(101)]) {
      expect(routineNameProblem(bad)).not.toBeNull();
    }
  });
});

describe("templates", () => {
  it("are valid routines with distinct ids and names", () => {
    expect(new Set(ROUTINE_TEMPLATES.map((t) => t.id)).size).toBe(ROUTINE_TEMPLATES.length);
    expect(ROUTINE_TEMPLATES.map((t) => t.id)).toEqual([
      "morning-briefing",
      "weekly-review",
      "carry-over",
      "price-watch",
      "news-digest",
      "inbox-triage",
    ]);
    for (const template of ROUTINE_TEMPLATES) {
      expect(parseSchedule(template.schedule).ok).toBe(true);
      expect(routineNameProblem(template.name)).toBeNull();
      expect(parseRoutineFile(renderRoutineFile(template)).problems).toEqual([]);
    }
  });
});
