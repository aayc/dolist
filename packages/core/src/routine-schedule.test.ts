import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  formatMinuteOfDay,
  nextRunAfter,
  parseSchedule,
  type RoutineSchedule,
  systemCalendar,
  timeZoneCalendar,
} from "./routine-schedule";

function schedule(phrase: string): RoutineSchedule {
  const parsed = parseSchedule(phrase);
  if (!parsed.ok) throw new Error(`${phrase}: ${parsed.error}`);
  return parsed.schedule;
}

const LA = timeZoneCalendar("America/Los_Angeles");
const BERLIN = timeZoneCalendar("Europe/Berlin");

/** Epoch ms of a wall-clock time in Los Angeles. */
function la(y: number, m: number, d: number, h = 0, min = 0): number {
  return LA.at(y, m, d, h * 60 + min);
}

function laText(ms: number | null): string {
  if (ms === null) return "none";
  const p = LA.parts(ms);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${days[p.weekday]} ${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

describe("parseSchedule", () => {
  it.each([
    ["every day at 7:30", "Every day at 7:30 AM"],
    ["Every day at 07:30.", "Every day at 7:30 AM"],
    ["everyday at 7:30", "Every day at 7:30 AM"],
    ["daily at 8", "Every day at 8:00 AM"],
    ["each day at 6pm", "Every day at 6:00 PM"],
    ["every weekday at 7:30", "Every weekday at 7:30 AM"],
    ["weekdays at 7:30 am", "Every weekday at 7:30 AM"],
    ["every weekend at 10", "Every Saturday and Sunday at 10:00 AM"],
    ["every monday at 9", "Every Monday at 9:00 AM"],
    ["mondays at 9:00", "Every Monday at 9:00 AM"],
    ["every mon, wed and fri at 18:30", "Every Monday, Wednesday and Friday at 6:30 PM"],
    ["every monday & thursday at 9", "Every Monday and Thursday at 9:00 AM"],
    ["every sunday at 18:00", "Every Sunday at 6:00 PM"],
    ["weekly on friday at 17:00", "Every Friday at 5:00 PM"],
    ["every week on tuesday at noon", "Every Tuesday at 12:00 PM"],
    ["every day at 8:00 and 17:00", "Every day at 8:00 AM and 5:00 PM"],
    ["every weekday at 9, 13 and 17", "Every weekday at 9:00 AM, 1:00 PM and 5:00 PM"],
    ["at 7 every day", "Every day at 7:00 AM"],
    ["every day at midnight", "Every day at 12:00 AM"],
    ["every day at 12am", "Every day at 12:00 AM"],
    ["every day at 12pm", "Every day at 12:00 PM"],
    ["every day at 7 p.m.", "Every day at 7:00 PM"],
    ["every hour", "Every hour"],
    ["hourly", "Every hour"],
    ["every 2 hours", "Every 2 hours"],
    ["every 2h", "Every 2 hours"],
    ["every 30 minutes", "Every 30 minutes"],
    ["every 15 min", "Every 15 minutes"],
    ["every 45m", "Every 45 minutes"],
    ["every hour from 9:00 to 17:00", "Every hour from 9:00 AM to 5:00 PM"],
    [
      "every hour between 9am and 5pm on weekdays",
      "Every hour from 9:00 AM to 5:00 PM on weekdays",
    ],
    ["every 2 hours on weekdays from 9 to 17", "Every 2 hours from 9:00 AM to 5:00 PM on weekdays"],
    ["every hour on saturday", "Every hour on Saturday"],
    ["every month on the 1st at 9:00", "Every month on the 1st at 9:00 AM"],
    ["monthly on the 15th at 8", "Every month on the 15th at 8:00 AM"],
    ["every month on day 3 at 9", "Every month on the 3rd at 9:00 AM"],
    ["every month on the last day at 18:00", "Every month on the last day at 6:00 PM"],
    ["on the 22nd at 9", "Every month on the 22nd at 9:00 AM"],
  ])("reads %j", (phrase, words) => {
    expect(describeSchedule(schedule(phrase))).toBe(words);
  });

  it("parses into the recurrence", () => {
    expect(schedule("every weekday at 7:30")).toEqual({
      kind: "weekly",
      days: [1, 2, 3, 4, 5],
      times: [450],
    });
    expect(schedule("every 2 hours from 9 to 17 on weekdays")).toEqual({
      kind: "interval",
      minutes: 120,
      days: [1, 2, 3, 4, 5],
      from: 540,
      to: 1020,
    });
    expect(schedule("every month on the last day at 9")).toEqual({
      kind: "monthly",
      day: -1,
      times: [540],
    });
    expect(schedule("every day at 17:00 and 8:00 and 8:00")).toMatchObject({ times: [480, 1020] });
  });

  it.each([
    ["", /Add a schedule/],
    ["whenever", /Couldn't read “whenever”/],
    ["every day", /Add a time: “every day” needs one/],
    ["every weekday", /“every weekday at 8:00”/],
    ["every morning", /Say when/],
    ["every 5 minutes", /at most every 15 minutes/],
    ["every minute", /at most every 15 minutes/],
    ["every 13 hours", /name the times instead/],
    ["every 2 days at 9", /isn't supported: name the days/],
    ["every other monday at 9", /“every other …” isn't supported/],
    ["every day at 25:00", /isn't a time/],
    ["every day at 13pm", /the hour is 1 to 12/],
    ["every day at 7:75", /isn't a time/],
    ["every hour at 9:00", /runs on its own clock/],
    ["every day at 9 from 9 to 17", /only goes with an interval/],
    ["every hour from 17 to 9", /end after it starts/],
    ["every month at 9", /which day of the month/],
    ["every month on the 1st", /Add a time/],
    ["every month on the 32nd at 9", /isn't a day of the month/],
    ["every week at 9", /Say which day/],
    ["every monday at 9 and thursday at 10", /Couldn't read “and”/],
    ["every 3 fortnights", /Every 3 what/],
    ["at 9", /Say how often/],
  ])("rejects %j with a hint", (phrase, error) => {
    const parsed = parseSchedule(phrase);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(error);
  });

  it("formats times of day", () => {
    expect([0, 1, 450, 720, 765, 1439].map(formatMinuteOfDay)).toEqual([
      "12:00 AM",
      "12:01 AM",
      "7:30 AM",
      "12:00 PM",
      "12:45 PM",
      "11:59 PM",
    ]);
  });
});

describe("nextRunAfter", () => {
  const next = (phrase: string, after: number) => laText(nextRunAfter(schedule(phrase), after, LA));

  it.each([
    // Friday 2026-09-25.
    ["every day at 7:30", la(2026, 9, 25, 6, 0), "Fri 2026-09-25 07:30"],
    ["every day at 7:30", la(2026, 9, 25, 7, 30), "Sat 2026-09-26 07:30"],
    ["every weekday at 7:30", la(2026, 9, 25, 8, 0), "Mon 2026-09-28 07:30"],
    ["every weekend at 10", la(2026, 9, 25, 8, 0), "Sat 2026-09-26 10:00"],
    ["every sunday at 18:00", la(2026, 9, 27, 18, 0), "Sun 2026-10-04 18:00"],
    ["every day at 8:00 and 17:00", la(2026, 9, 25, 9, 0), "Fri 2026-09-25 17:00"],
    ["every hour", la(2026, 9, 25, 9, 0), "Fri 2026-09-25 10:00"],
    ["every hour", la(2026, 9, 25, 23, 30), "Sat 2026-09-26 00:00"],
    ["every 30 minutes", la(2026, 9, 25, 9, 10), "Fri 2026-09-25 09:30"],
    ["every 90 minutes", la(2026, 9, 25, 22, 31), "Sat 2026-09-26 00:00"],
    ["every hour from 9 to 17 on weekdays", la(2026, 9, 25, 17, 0), "Mon 2026-09-28 09:00"],
    ["every hour from 9 to 17", la(2026, 9, 25, 16, 59), "Fri 2026-09-25 17:00"],
    ["every month on the 1st at 9", la(2026, 9, 25, 0, 0), "Thu 2026-10-01 09:00"],
    ["every month on the 31st at 9", la(2026, 9, 1, 0, 0), "Wed 2026-09-30 09:00"],
    ["every month on the 31st at 9", la(2027, 2, 1, 0, 0), "Sun 2027-02-28 09:00"],
    ["every month on the 29th at 9", la(2028, 2, 1, 0, 0), "Tue 2028-02-29 09:00"],
    ["every month on the last day at 18:00", la(2026, 12, 31, 19, 0), "Sun 2027-01-31 18:00"],
  ])("%s after %s", (phrase, after, expected) => {
    expect(next(phrase, after as number)).toBe(expected);
  });

  describe("across daylight saving changes (America/Los_Angeles)", () => {
    // 2026-03-08: 2:00 → 3:00 (PST → PDT). 2026-11-01: 2:00 → 1:00 (PDT → PST).
    it("a time the clock skips runs right after the gap, once", () => {
      const at = nextRunAfter(schedule("every day at 2:30"), la(2026, 3, 8, 0, 0), LA)!;
      expect(laText(at)).toBe("Sun 2026-03-08 03:30");
      expect(laText(nextRunAfter(schedule("every day at 2:30"), at, LA))).toBe(
        "Mon 2026-03-09 02:30",
      );
    });

    it("a time the clock repeats runs once, at its first occurrence", () => {
      const first = nextRunAfter(schedule("every day at 1:30"), la(2026, 11, 1, 0, 0), LA)!;
      expect(new Date(first).toISOString()).toBe("2026-11-01T08:30:00.000Z"); // 1:30 PDT
      const after = nextRunAfter(schedule("every day at 1:30"), first, LA)!;
      expect(laText(after)).toBe("Mon 2026-11-02 01:30");
    });

    it("local times stay put across the change", () => {
      let at = la(2026, 3, 6, 12, 0);
      const runs: string[] = [];
      for (let i = 0; i < 4; i++) {
        at = nextRunAfter(schedule("every day at 7:30"), at, LA)!;
        runs.push(laText(at));
      }
      expect(runs).toEqual([
        "Sat 2026-03-07 07:30",
        "Sun 2026-03-08 07:30",
        "Mon 2026-03-09 07:30",
        "Tue 2026-03-10 07:30",
      ]);
      // The day of the change is an hour shorter.
      expect(la(2026, 3, 9, 7, 30) - la(2026, 3, 8, 7, 30)).toBe(24 * 3600_000);
      expect(la(2026, 3, 8, 7, 30) - la(2026, 3, 7, 7, 30)).toBe(23 * 3600_000);
    });

    it("hourly runs follow the local clock through both changes", () => {
      const hourly = schedule("every hour");
      const runs = (from: number, count: number) => {
        const out: string[] = [];
        let at = from;
        for (let i = 0; i < count; i++) {
          at = nextRunAfter(hourly, at, LA)!;
          out.push(laText(at).slice(-5));
        }
        return out;
      };
      expect(runs(la(2026, 3, 8, 0, 30), 3)).toEqual(["01:00", "03:00", "04:00"]);
      expect(runs(la(2026, 11, 1, 0, 30), 3)).toEqual(["01:00", "02:00", "03:00"]);
    });

    it("works the same in another zone (Europe/Berlin, 2026-03-29)", () => {
      const at = nextRunAfter(schedule("every day at 2:30"), BERLIN.at(2026, 3, 29, 0), BERLIN)!;
      expect(new Date(at).toISOString()).toBe("2026-03-29T01:30:00.000Z"); // 3:30 CEST
    });
  });

  it("uses the machine's clock by default, like timeZoneCalendar of its zone", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const calendar = timeZoneCalendar(zone);
    const now = Date.UTC(2026, 8, 25, 14, 3);
    for (const phrase of ["every day at 7:30", "every 2 hours", "every month on the 1st at 9"]) {
      expect(nextRunAfter(schedule(phrase), now)).toBe(
        nextRunAfter(schedule(phrase), now, calendar),
      );
    }
    expect(systemCalendar.parts(now)).toEqual(calendar.parts(now));
  });
});
