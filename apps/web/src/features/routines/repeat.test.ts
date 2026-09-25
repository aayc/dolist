import { routineNameProblem } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { repeatDraft, routineNameFor } from "./repeat";

describe("Repeat this", () => {
  it("drafts a routine from the task: its text as instructions, no schedule yet", () => {
    expect(repeatDraft({ id: "thr_1", title: "Check the  weather\nin SF" })).toEqual({
      name: "Check the weather in SF",
      instructions: "Check the weather in SF",
      notify: "always",
      fromThreadId: "thr_1",
    });
  });

  it.each([
    ["Compare flights: SFO → JFK", "Compare flights SFO → JFK"],
    ["Read #news / [tech] digest", "Read news tech digest"],
    ["...hidden", "hidden"],
    [". .x", "x"],
    [
      "Summarize the most important news about renewable energy policy and battery storage",
      "Summarize the most important news about renewable energy",
    ],
    ["x".repeat(80), "x".repeat(60)],
  ])("names %j as %j", (text, name) => {
    expect(routineNameFor(text)).toBe(name);
  });

  test.prop([fc.string({ minLength: 1, maxLength: 300 })])(
    "always gives a name the daemon accepts, or an empty one to fill in",
    (text) => {
      const name = routineNameFor(text);
      if (name !== "") expect(routineNameProblem(name)).toBeNull();
    },
  );
});
