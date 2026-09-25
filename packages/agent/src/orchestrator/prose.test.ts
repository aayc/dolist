import { describe, expect, it } from "vitest";
import { mayBeRequest } from "./prose";

describe("mayBeRequest", () => {
  it.each([
    "What's the tallest building in NYC?",
    "- is the pharmacy open on Sunday?",
    "@agent summarize the standup notes",
    "agent: find a plumber for Saturday",
    "TODO: renew the car registration",
    "Find a good ramen place near the office",
    "look up the train times to Boston",
    "Please compare the two insurance quotes",
    "## Can you plan a weekend in Lisbon",
    "Remind me to water the plants",
    "Every morning, brief me on my calendar and the weather",
    "each weekday at 7:30 send me the top headlines",
  ])("wakes the orchestrator: %s", (line) => {
    expect(mayBeRequest(line)).toBe(true);
  });

  it.each([
    "Slept badly, lots of meetings today.",
    "# Thursday",
    "Notes from standup: ship the launch review by Friday.",
    "- met Sam for coffee",
    "Every day I walk the dog before work.",
    "Ideas: raised beds, drip irrigation",
    "ok",
    "",
  ])("stays quiet for the user's own notes: %s", (line) => {
    expect(mayBeRequest(line)).toBe(false);
  });
});
