import type { Routine } from "@ddl/core";

/** A valid routine for tests (synthetic data). */
export function routineFixture(patch: Partial<Routine> = {}): Routine {
  const name = patch.name ?? "Morning briefing";
  return {
    id: "rtn_1",
    path: `Routines/${name}.md`,
    name,
    schedule: "every weekday at 7:30",
    scheduleText: "Every weekday at 7:30 AM",
    notify: "always",
    uses: [],
    paused: false,
    instructions: "Brief me for the day.",
    runCount: 0,
    extraRunsLeft: 5,
    ...patch,
  };
}
