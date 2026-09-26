import { pluralize, type Routine, type RoutineNotify } from "@ddl/core";

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function startOfDay(ts: number): number {
  const date = new Date(ts);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Local calendar days from `now` to `at` (a DST day is still one day). */
export function localDayDiff(now: number, at: number): number {
  return Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
}

/**
 * A moment near now, in words: "today at 7:30 AM", "tomorrow at …", "yesterday at …", "Friday at
 * …" (later this week), else "Sep 30 at …" (with the year when it isn't this one).
 */
export function formatDayTime(at: number, now: number = Date.now()): string {
  const days = localDayDiff(now, at);
  const time = clock.format(at);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  if (days > 1 && days < 7) return `${weekday.format(at)} at ${time}`;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return `${(sameYear ? monthDay : monthDayYear).format(at)} at ${time}`;
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The schedule in words, or as written when the daemon couldn't read it. */
export function scheduleLabel(routine: Pick<Routine, "schedule" | "scheduleText">): string {
  return routine.scheduleText ?? (routine.schedule || "No schedule");
}

/** When it runs next, as a phrase after "Next run": absent while it won't run on its own. */
export function nextRunLabel(
  routine: Pick<Routine, "nextRunAt" | "paused" | "error">,
  now: number = Date.now(),
): string | null {
  if (routine.error || routine.paused || routine.nextRunAt === undefined) return null;
  return formatDayTime(routine.nextRunAt, now);
}

/** Why a routine won't run on its own, if it won't. */
export function idleReason(
  routine: Pick<Routine, "error" | "paused" | "nextRunAt">,
): string | null {
  if (routine.error) return "It can't run until its file is fixed.";
  if (routine.paused) return "Paused: it won't run until you resume it.";
  if (routine.nextRunAt === undefined) return "It has no upcoming run.";
  return null;
}

export const NOTIFY_LABELS: Record<RoutineNotify, string> = {
  always: "After every run",
  when_changed: "When something changed",
  never: "Never",
};

export function extraRunsLabel(left: number): string {
  if (left === 0) return "No extra runs left today";
  return `${pluralize(left, "extra run")} left today`;
}
