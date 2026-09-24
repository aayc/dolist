import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_NOTE_SETTINGS,
  dailyNotePath,
  findAdjacentDailyNote,
  isDailyNotePath,
  listDailyNotes,
  navigationAnchorDate,
  parseDailyNotePath,
  templateNotePath,
  weeklyNotePath,
} from "./daily-notes";
import { renderTemplate } from "./template";

const settings = DEFAULT_DAILY_NOTE_SETTINGS;

describe("daily note paths", () => {
  it("builds and parses paths with the Obsidian defaults", () => {
    const date = { year: 2026, month: 9, day: 23 };
    expect(dailyNotePath(date, settings)).toBe("Daily/2026-09-23.md");
    expect(parseDailyNotePath("Daily/2026-09-23.md", settings)).toEqual(date);
    expect(isDailyNotePath("Daily/notes.md", settings)).toBe(false);
    expect(isDailyNotePath("Other/2026-09-23.md", settings)).toBe(false);
  });

  it("supports nested formats and a root folder", () => {
    const nested = { folder: "", format: "YYYY/MM/YYYY-MM-DD", template: "" };
    const date = { year: 2026, month: 1, day: 5 };
    expect(dailyNotePath(date, nested)).toBe("2026/01/2026-01-05.md");
    expect(parseDailyNotePath("2026/01/2026-01-05.md", nested)).toEqual(date);
  });

  it("tolerates trailing slashes in the folder setting (Obsidian writes `Daily/`)", () => {
    const s = { ...settings, folder: "Daily/" };
    expect(dailyNotePath({ year: 2026, month: 9, day: 23 }, s)).toBe("Daily/2026-09-23.md");
  });
});

describe("adjacent daily notes", () => {
  const paths = [
    "Daily/2026-09-18.md",
    "Daily/2026-09-21.md",
    "Daily/2026-09-22.md",
    "Daily/2026-09-25.md",
    "Projects/2026-09-20.md",
    "Daily/readme.md",
  ];

  it("finds the previous existing note, skipping gaps (Cmd+Shift+P)", () => {
    const from = { year: 2026, month: 9, day: 21 };
    expect(findAdjacentDailyNote(paths, from, -1, settings)?.path).toBe("Daily/2026-09-18.md");
  });

  it("finds the next existing note", () => {
    const from = { year: 2026, month: 9, day: 22 };
    expect(findAdjacentDailyNote(paths, from, 1, settings)?.path).toBe("Daily/2026-09-25.md");
  });

  it("returns null at the edges", () => {
    expect(
      findAdjacentDailyNote(paths, { year: 2026, month: 9, day: 18 }, -1, settings),
    ).toBeNull();
  });

  it("anchors navigation to the open daily note, else today", () => {
    const now = new Date(2026, 8, 23, 9);
    expect(navigationAnchorDate("Daily/2026-09-21.md", settings, now)).toEqual({
      year: 2026,
      month: 9,
      day: 21,
    });
    expect(navigationAnchorDate("Ideas.md", settings, now)).toEqual({
      year: 2026,
      month: 9,
      day: 23,
    });
  });

  it("lists daily notes chronologically", () => {
    expect(listDailyNotes(paths, settings).map((n) => n.path)).toEqual([
      "Daily/2026-09-18.md",
      "Daily/2026-09-21.md",
      "Daily/2026-09-22.md",
      "Daily/2026-09-25.md",
    ]);
  });
});

describe("templates", () => {
  it("normalizes template paths", () => {
    expect(templateNotePath({ template: "Templates/Daily" })).toBe("Templates/Daily.md");
    expect(templateNotePath({ template: "  " })).toBeNull();
  });

  it("renders Obsidian template variables", () => {
    const out = renderTemplate("# {{title}}\n{{date:dddd}} {{date}} {{time}} {{unknown}}", {
      title: "2026-09-23",
      date: { year: 2026, month: 9, day: 23 },
      now: new Date(2026, 8, 23, 7, 5),
    });
    expect(out).toBe("# 2026-09-23\nWednesday 2026-09-23 07:05 {{unknown}}");
  });

  it("builds weekly note paths", () => {
    expect(
      weeklyNotePath(
        { year: 2026, month: 9, day: 23 },
        { folder: "Weekly/", format: "", template: "" },
      ),
    ).toBe("Weekly/2026-W39.md");
  });
});
