import type { StateCommand } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { runMarked } from "../test-helpers";
import { continueListItem, continueMarkup, indentListItemOrInsertTab } from "./lists";

/** The Enter bindings, in keymap order. */
const enter: StateCommand = (target) => continueMarkup(target) || continueListItem(target);

describe("Enter", () => {
  it("continues tasks with an unchecked box", () => {
    expect(runMarked("- [ ] first|", enter)).toBe("- [ ] first\n- [ ] |");
    expect(runMarked("- [x] done|", enter)).toBe("- [x] done\n- [ ] |");
    expect(runMarked("- parent\n\t- [ ] nested|", enter)).toBe(
      "- parent\n\t- [ ] nested\n\t- [ ] |",
    );
  });

  it("continues top-level items indented with a tab", () => {
    expect(runMarked("\t- [ ] indented|", enter)).toBe("\t- [ ] indented\n\t- [ ] |");
    expect(runMarked("\t- [x] split |here", enter)).toBe("\t- [x] split\n\t- [ ] |here");
    expect(runMarked("\t3) third|", enter)).toBe("\t3) third\n\t4) |");
    expect(runMarked("\t- [ ] |", enter)).toBe("|");
  });

  it("continues bullets and numbered lists", () => {
    expect(runMarked("- item|", enter)).toBe("- item\n- |");
    expect(runMarked("1. one|", enter)).toBe("1. one\n2. |");
  });

  it("ends the list when pressed on an empty item", () => {
    expect(runMarked("- [ ] a\n- [ ] |", enter)).toBe("- [ ] a\n|");
  });

  it("leaves code blocks and positions before the marker to the default Enter", () => {
    expect(runMarked("```\n- [ ] code|\n```", enter)).toBeNull();
    expect(runMarked("|- [ ] a", continueListItem)).toBeNull();
  });
});

describe("Tab", () => {
  it("indents list items with a tab and inserts tabs elsewhere", () => {
    expect(runMarked("- [ ] a\n- [ ] b|", indentListItemOrInsertTab)).toBe("- [ ] a\n\t- [ ] b|");
    expect(runMarked("text|", indentListItemOrInsertTab)).toBe("text\t|");
  });
});
