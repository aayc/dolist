import { describe, expect, it } from "vitest";
import { HttpError, NetworkError } from "../../api/errors";
import { createProblem, runProblem } from "./routine-errors";

function daemonError(status: number, error: string, message?: string): HttpError {
  return new HttpError(status, message ?? error, { error, ...(message ? { message } : {}) });
}

describe("runProblem", () => {
  it.each([
    [
      daemonError(409, "conflict", "“Morning briefing” is running right now."),
      "It can't run right now",
      "“Morning briefing” is running right now.",
    ],
    [
      daemonError(
        409,
        "conflict",
        "“Morning briefing” already ran the most extra times allowed today; it runs again on its schedule.",
      ),
      "It can't run right now",
      "“Morning briefing” already ran the most extra times allowed today; it runs again on its schedule.",
    ],
    [
      daemonError(
        409,
        "conflict",
        "“Morning briefing” can't run: Add a schedule to the frontmatter.",
      ),
      "It can't run right now",
      "“Morning briefing” can't run: Add a schedule to the frontmatter.",
    ],
    [
      daemonError(503, "agent_unavailable", "The agent is paused: switch it on to run routines."),
      "The agent can't run here",
      "The agent is paused: switch it on to run routines.",
    ],
    [
      daemonError(404, "not_found", "Routine not found"),
      "This routine is gone",
      "Its file was moved or deleted.",
    ],
    [new NetworkError("Failed to fetch"), "Couldn't reach Daily Do List", "Failed to fetch"],
    [new Error("boom"), "Couldn't start the run", "boom"],
  ])("maps %s", (error, title, body) => {
    expect(runProblem(error)).toEqual({ title, body });
  });

  it("falls back to a reason of its own when the daemon gave none", () => {
    expect(runProblem(new HttpError(409, "")).body).toBe(
      "A run is going, or today's extra runs are used up.",
    );
    expect(runProblem(new HttpError(503, " ")).body).toBe(
      "The agent isn't running on this device.",
    );
  });
});

describe("createProblem", () => {
  const request = {
    name: "Morning briefing",
    schedule: "every weekday at 7:30",
    instructions: "Brief me.",
  };

  it("shows a 400 under the schedule when the name and instructions are fine", () => {
    const error = daemonError(400, "invalid_request", "I can't read “whenever” as a schedule.");
    expect(createProblem(error, { ...request, schedule: "whenever" })).toEqual({
      field: "schedule",
      message: "I can't read “whenever” as a schedule.",
    });
  });

  it("shows a 400 under the name or the instructions when that's what's wrong", () => {
    const error = daemonError(400, "invalid_request", "A routine's name can't contain / or :.");
    expect(createProblem(error, { ...request, name: "a/b" }).field).toBe("name");
    expect(createProblem(error, { ...request, name: " padded " }).field).toBe("name");
    expect(createProblem(error, { ...request, instructions: "  " }).field).toBe("instructions");
    expect(createProblem(error, { ...request, instructions: "x".repeat(8_001) }).field).toBe(
      "instructions",
    );
  });

  it("puts a 409 (the name exists) under the name", () => {
    const error = daemonError(
      409,
      "conflict",
      "A routine named “Morning briefing” already exists.",
    );
    expect(createProblem(error, request)).toEqual({
      field: "name",
      message: "A routine named “Morning briefing” already exists.",
    });
  });

  it("puts anything else above the buttons", () => {
    expect(createProblem(new NetworkError("Failed to fetch"), request)).toEqual({
      field: null,
      message: "Failed to fetch",
    });
    expect(
      createProblem(daemonError(500, "internal_error", "Disk full"), request).field,
    ).toBeNull();
  });
});
