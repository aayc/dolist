import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings";

describe("editor settings", () => {
  it("default to vim off with an empty vimrc", () => {
    expect(DEFAULT_SETTINGS.editor.vimMode).toBe(false);
    expect(DEFAULT_SETTINGS.editor.vimrc).toBe("");
  });

  it("keep the vimrc default when a patch or an older payload doesn't carry it", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { editor: { vimMode: true } });
    expect(merged.editor).toMatchObject({ vimMode: true, vimrc: "" });
    const patched = mergeSettings(merged, { editor: { vimrc: "imap jj <Esc>\n" } });
    expect(patched.editor.vimrc).toBe("imap jj <Esc>\n");
    expect(patched.editor.vimMode).toBe(true);
  });
});
