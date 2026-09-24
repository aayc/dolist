import { describe, expect, it } from "vitest";
import { ctrlKeysOf, forgetMappings, isVimCtrlKey, noteMapping } from "./vim-keys";

// The default list is checked against vim.js's own keymap in test/vim/unit/vim-keys.test.ts.
describe("vim's Ctrl keys", () => {
  it("adds the Ctrl keys mappings start with, except insert-mode mappings", () => {
    expect(ctrlKeysOf("<C-j>")).toEqual(["<C-j>"]);
    expect(ctrlKeysOf("<C-J>x")).toEqual(["<C-j>"]);
    expect(ctrlKeysOf("<C-S-k>")).toEqual(["<C-k>"]);
    expect(ctrlKeysOf("jj")).toEqual([]);
    expect(isVimCtrlKey("<C-j>")).toBe(false);
    noteMapping("<C-j>", undefined);
    noteMapping("<C-l>", "insert");
    expect(isVimCtrlKey("<C-j>")).toBe(true);
    expect(isVimCtrlKey("<C-l>")).toBe(false);
    expect(isVimCtrlKey("<C-o>")).toBe(true);
    expect(isVimCtrlKey("<C-s>")).toBe(false);
    forgetMappings();
    expect(isVimCtrlKey("<C-j>")).toBe(false);
  });
});
