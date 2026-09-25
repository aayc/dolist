import { describe, expect, it } from "vitest";
import { codeProblem, formatCodeInput } from "./pairing-code";
import { countdown, timeAgo } from "./time";

describe("typing a pairing code", () => {
  it.each([
    ["abcd", "ABCD"],
    ["abcde", "ABCD-E"],
    ["ABCD-EFGH", "ABCD-EFGH"],
    ["abcd efgh", "ABCD-EFGH"],
    [" ab-cd ef gh ", "ABCD-EFGH"],
    ["ABCD-EFGHJK", "ABCD-EFGH"],
    ["ABCD-", "ABCD"],
    ["a?b!c.d", "ABCD"],
  ])("%j shows as %j", (raw, value) => {
    expect(formatCodeInput(raw).value).toBe(value);
  });

  it("keeps the caret after the characters it followed", () => {
    // Typing at the end, past the dash.
    expect(formatCodeInput("ABCDE", 5)).toEqual({ value: "ABCD-E", caret: 6 });
    // Inserting in the middle of the first half.
    expect(formatCodeInput("ABXCD-EF", 3)).toEqual({ value: "ABXC-DEF", caret: 3 });
    // Deleting the dash puts the caret before where it was.
    expect(formatCodeInput("ABCDEF", 4)).toEqual({ value: "ABCD-EF", caret: 4 });
    // Deleting back to four characters drops the dash.
    expect(formatCodeInput("ABCD-", 5)).toEqual({ value: "ABCD", caret: 4 });
  });

  it("says what's wrong with a code that can't be sent", () => {
    expect(codeProblem("ABCD-EFGH")).toBeNull();
    expect(codeProblem("abcdefgh")).toBeNull();
    expect(codeProblem("ABCD-EF")).toBe("Enter all 8 characters.");
    expect(codeProblem("ABCD-EFG0")).toBe("Codes never use 0, 1, I, L, O or U: check the code.");
  });
});

describe("times", () => {
  const now = new Date(2026, 8, 25, 12, 0, 0).getTime();

  it("says how long ago", () => {
    expect(timeAgo(now - 10_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(timeAgo(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(timeAgo(now - 3 * 60 * 60_000, now)).toBe("3 hours ago");
    expect(timeAgo(now + 5_000, now)).toBe("just now");
    expect(timeAgo(now - 3 * 24 * 60 * 60_000, now)).toMatch(/Sep 22/);
  });

  it("counts down", () => {
    expect(countdown(5 * 60_000)).toBe("5:00");
    expect(countdown(299_001)).toBe("5:00");
    expect(countdown(298_500)).toBe("4:59");
    expect(countdown(9_000)).toBe("0:09");
    expect(countdown(-1)).toBe("0:00");
  });
});
