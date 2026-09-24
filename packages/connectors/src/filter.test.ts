import { describe, expect, it } from "vitest";
import { isToolAllowed, matchesToolPattern } from "./filter";

describe("matchesToolPattern", () => {
  it("matches exact names and * globs only", () => {
    expect(matchesToolPattern("read_file", "read_file")).toBe(true);
    expect(matchesToolPattern("read_file", "read_files")).toBe(false);
    expect(matchesToolPattern("read_*", "read_file")).toBe(true);
    expect(matchesToolPattern("*_file", "write_file")).toBe(true);
    expect(matchesToolPattern("*", "anything")).toBe(true);
    expect(matchesToolPattern("gmail.*.send", "gmail.draft.send")).toBe(true);
  });

  it("treats regex metacharacters literally", () => {
    expect(matchesToolPattern("a.b", "aXb")).toBe(false);
    expect(matchesToolPattern("a+(b)*", "a+(b)anything")).toBe(true);
    expect(matchesToolPattern("a+(b)*", "aa(b)")).toBe(false);
  });
});

describe("isToolAllowed", () => {
  it("allows everything without a filter", () => {
    expect(isToolAllowed(undefined, "delete_repo")).toBe(true);
    expect(isToolAllowed({}, "delete_repo")).toBe(true);
    expect(isToolAllowed({ include: [] }, "delete_repo")).toBe(true);
  });

  it("applies include first, then exclude", () => {
    const filter = { include: ["read_*", "search"], exclude: ["read_secrets"] };
    expect(isToolAllowed(filter, "read_file")).toBe(true);
    expect(isToolAllowed(filter, "search")).toBe(true);
    expect(isToolAllowed(filter, "read_secrets")).toBe(false);
    expect(isToolAllowed(filter, "write_file")).toBe(false);
    expect(isToolAllowed({ exclude: ["delete_*"] }, "delete_repo")).toBe(false);
    expect(isToolAllowed({ exclude: ["delete_*"] }, "create_repo")).toBe(true);
  });
});
