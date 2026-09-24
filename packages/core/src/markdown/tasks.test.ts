import { describe, expect, it } from "vitest";
import { isBlankTaskText, parseTasks, setStatusCharOnLine, toggleTaskLine } from "./tasks";

const NOTE = [
  "---",
  "tags: [daily]",
  "- [ ] not a task (frontmatter)",
  "---",
  "- [x] Renew passport -> done at the post office",
  "- [ ] Book dentist appointment - prefer mornings",
  "  - call Dr. Lee first",
  "  - [ ] find insurance card",
  "    extra context line",
  "* [/] Draft Q4 plan",
  "1. [-] Cancelled thing",
  "- [>] Move to [[Daily/2026-09-24]]",
  "",
  "```",
  "- [ ] not a task (code)",
  "```",
  "Some freeform note",
  "- plain bullet",
  "- [ ]",
].join("\n");

describe("parseTasks", () => {
  const tasks = parseTasks(NOTE);

  it("finds tasks and skips frontmatter and code fences", () => {
    expect(tasks.map((t) => t.text)).toEqual([
      "Renew passport -> done at the post office",
      "Book dentist appointment - prefer mornings",
      "find insurance card",
      "Draft Q4 plan",
      "Cancelled thing",
      "Move to [[Daily/2026-09-24]]",
      "",
    ]);
  });

  it("maps status characters", () => {
    expect(tasks.map((t) => t.status)).toEqual([
      "done",
      "open",
      "open",
      "in_progress",
      "cancelled",
      "deferred",
      "open",
    ]);
  });

  it("tracks nesting, parents and notes", () => {
    const dentist = tasks[1]!;
    const insurance = tasks[2]!;
    expect(dentist.depth).toBe(0);
    expect(insurance.depth).toBe(1);
    expect(insurance.parentLine).toBe(dentist.line);
    expect(dentist.notes).toEqual(["call Dr. Lee first"]);
    expect(insurance.notes).toEqual(["extra context line"]);
  });

  it("records offsets that point into the document", () => {
    const dentist = tasks[1]!;
    expect(NOTE.slice(dentist.from, dentist.to)).toBe(dentist.raw);
    expect(NOTE.slice(dentist.textFrom, dentist.to)).toBe(dentist.text);
  });

  it("extracts wikilinks", () => {
    expect(tasks[5]!.links).toEqual(["Daily/2026-09-24"]);
  });

  it("handles CRLF documents", () => {
    const crlf = parseTasks("- [ ] one\r\n- [x] two\r\n");
    expect(crlf.map((t) => [t.text, t.status])).toEqual([
      ["one", "open"],
      ["two", "done"],
    ]);
  });
});

describe("task line edits", () => {
  it("toggles checkboxes", () => {
    expect(toggleTaskLine("- [ ] a")).toBe("- [x] a");
    expect(toggleTaskLine("  - [x] a")).toBe("  - [ ] a");
    expect(toggleTaskLine("plain")).toBe("plain");
    expect(setStatusCharOnLine("1. [ ] a", "/")).toBe("1. [/] a");
  });

  it("detects blank template tasks", () => {
    expect(isBlankTaskText("")).toBe(true);
    expect(isBlankTaskText(" … ")).toBe(true);
    expect(isBlankTaskText("Call mom")).toBe(false);
  });
});
