import { describe, expect, it } from "vitest";
import {
  capitalize,
  extraRunsLabel,
  formatDayTime,
  idleReason,
  localDayDiff,
  nextRunLabel,
  scheduleLabel,
} from "./routine-format";
import { routineFixture } from "./testing";

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
/** Thursday, September 24, 2026, 10:00 local time. */
const NOW = new Date(2026, 8, 24, 10, 0).getTime();

function at(month: number, day: number, hour = 7, minute = 30, year = 2026): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe("formatDayTime", () => {
  it.each([
    ["later today", at(9, 24, 18, 0), "today"],
    ["earlier today", at(9, 24, 0, 5), "today"],
    ["tomorrow", at(9, 25), "tomorrow"],
    ["yesterday", at(9, 23), "yesterday"],
    ["this weekend", at(9, 27), weekday.format(at(9, 27))],
    ["six days on", at(9, 30), weekday.format(at(9, 30))],
  ])("%s: the day in words", (_label, ts, day) => {
    expect(formatDayTime(ts, NOW)).toBe(`${day} at ${clock.format(ts)}`);
  });

  it("uses the date a week or more away, with the year only when it differs", () => {
    for (const ts of [at(10, 1), at(9, 20)]) {
      expect(formatDayTime(ts, NOW)).toBe(`${monthDay.format(ts)} at ${clock.format(ts)}`);
    }
    const nextYear = at(1, 4, 9, 0, 2027);
    expect(formatDayTime(nextYear, NOW)).toBe(
      `${monthDayYear.format(nextYear)} at ${clock.format(nextYear)}`,
    );
  });

  it("counts calendar days across a DST change", () => {
    expect(localDayDiff(at(3, 7, 23, 0, 2026), at(3, 9, 0, 30, 2026))).toBe(2);
    expect(localDayDiff(at(10, 31, 12, 0, 2026), at(11, 1, 23, 0, 2026))).toBe(1);
  });
});

describe("routine labels", () => {
  it("says the schedule in words, or as written when it can't be read", () => {
    expect(scheduleLabel(routineFixture())).toBe("Every weekday at 7:30 AM");
    expect(scheduleLabel({ schedule: "whenever", scheduleText: undefined })).toBe("whenever");
    expect(scheduleLabel({ schedule: "" })).toBe("No schedule");
  });

  it("says when it runs next, only while it runs on its own", () => {
    const next = at(9, 25);
    expect(nextRunLabel(routineFixture({ nextRunAt: next }), NOW)).toBe(
      `tomorrow at ${clock.format(next)}`,
    );
    expect(nextRunLabel(routineFixture({ nextRunAt: next, paused: true }), NOW)).toBeNull();
    expect(nextRunLabel(routineFixture({ nextRunAt: next, error: "Bad file" }), NOW)).toBeNull();
    expect(nextRunLabel(routineFixture(), NOW)).toBeNull();
  });

  it("explains why it won't run on its own, most important first", () => {
    expect(idleReason(routineFixture({ error: "x", paused: true }))).toBe(
      "It can't run until its file is fixed.",
    );
    expect(idleReason(routineFixture({ paused: true }))).toBe(
      "Paused: it won't run until you resume it.",
    );
    expect(idleReason(routineFixture())).toBe("It has no upcoming run.");
    expect(idleReason(routineFixture({ nextRunAt: NOW }))).toBeNull();
  });

  it("counts the extra runs left", () => {
    expect(extraRunsLabel(5)).toBe("5 extra runs left today");
    expect(extraRunsLabel(1)).toBe("1 extra run left today");
    expect(extraRunsLabel(0)).toBe("No extra runs left today");
    expect(capitalize("tomorrow at 7:30 AM")).toBe("Tomorrow at 7:30 AM");
  });
});
