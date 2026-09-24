// @vitest-environment happy-dom
import { type AppSettings, DEFAULT_SETTINGS } from "@ddl/core";
import { describe, expect, it, vi } from "vitest";
import { applySettings, getSettings } from "./settings-store";

vi.mock("@ddl/editor", () => ({ preloadVim: () => Promise.resolve() }));

describe("applySettings", () => {
  it("fills in fields an older daemon doesn't send (the vimrc) with their defaults", () => {
    const { vimrc: _vimrc, ...olderEditor } = DEFAULT_SETTINGS.editor;
    applySettings({
      ...DEFAULT_SETTINGS,
      editor: { ...olderEditor, vimMode: true },
    } as AppSettings);
    expect(getSettings().editor).toMatchObject({ vimMode: true, vimrc: "" });
  });

  it("keeps a vimrc the daemon sends", () => {
    applySettings({
      ...DEFAULT_SETTINGS,
      editor: { ...DEFAULT_SETTINGS.editor, vimrc: "nmap j gj" },
    });
    expect(getSettings().editor.vimrc).toBe("nmap j gj");
  });
});
