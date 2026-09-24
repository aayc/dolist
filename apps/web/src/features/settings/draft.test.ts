import { describe, expect, it } from "vitest";
import { draftToCommit } from "./draft";

describe("draftToCommit", () => {
  it("saves any change to an optional setting as typed, including blank", () => {
    expect(draftToCommit("Journal", "Daily")).toBe("Journal");
    expect(draftToCommit("", "Daily")).toBe("");
    expect(draftToCommit(" Daily ", "Daily")).toBe(" Daily ");
    expect(draftToCommit("Daily", "Daily")).toBeNull();
  });

  it("saves a required setting trimmed, and only when that changes it", () => {
    expect(draftToCommit("  gpt-5.5\t", "composer-2.5", true)).toBe("gpt-5.5");
    expect(draftToCommit("composer-2.5 ", "composer-2.5", true)).toBeNull();
  });

  it("never saves a blank required setting", () => {
    expect(draftToCommit("", "composer-2.5", true)).toBeNull();
    expect(draftToCommit("   ", "composer-2.5", true)).toBeNull();
  });
});
