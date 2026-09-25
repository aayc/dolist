import { ROUTINE_TEMPLATES } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { routineFixture } from "../features/routines/testing";
import {
  applyRoutine,
  applyRoutineList,
  applyRoutinesChanged,
  findRoutine,
  initialRoutinesState,
} from "./routines-store";

const briefing = routineFixture({ id: "rtn_b", name: "Morning briefing" });
const review = routineFixture({ id: "rtn_r", name: "Weekly review" });
const digest = routineFixture({ id: "rtn_d", name: "News digest" });

describe("routines store", () => {
  it("takes the list and the templates, sorted by name", () => {
    const state = applyRoutineList(
      { ...initialRoutinesState, status: "error", error: "offline" },
      { routines: [review, briefing], templates: [...ROUTINE_TEMPLATES] },
    );
    expect(state.routines.map((r) => r.name)).toEqual(["Morning briefing", "Weekly review"]);
    expect(state.templates).toHaveLength(ROUTINE_TEMPLATES.length);
    expect(state).toMatchObject({ status: "loaded", error: null, templatesLoaded: true });
  });

  it("replaces the whole list on routines.changed and keeps the templates", () => {
    const loaded = applyRoutineList(initialRoutinesState, {
      routines: [briefing, review],
      templates: [...ROUTINE_TEMPLATES],
    });
    const changed = applyRoutinesChanged(loaded, [digest, { ...review, paused: true }]);
    expect(changed.routines.map((r) => r.name)).toEqual(["News digest", "Weekly review"]);
    expect(findRoutine(changed, "rtn_r")?.paused).toBe(true);
    expect(changed.templates).toBe(loaded.templates);
  });

  it("counts as loaded after a routines.changed even before the list arrived", () => {
    const state = applyRoutinesChanged(initialRoutinesState, [briefing]);
    expect(state).toMatchObject({ status: "loaded", templatesLoaded: false });
  });

  it("puts one routine an action returned in place, or adds it in name order", () => {
    const state = applyRoutinesChanged(initialRoutinesState, [briefing, review]);
    const paused = applyRoutine(state, { ...briefing, paused: true });
    expect(paused.routines.map((r) => [r.name, r.paused])).toEqual([
      ["Morning briefing", true],
      ["Weekly review", false],
    ]);
    const added = applyRoutine(state, digest);
    expect(added.routines.map((r) => r.name)).toEqual([
      "Morning briefing",
      "News digest",
      "Weekly review",
    ]);
  });
});
