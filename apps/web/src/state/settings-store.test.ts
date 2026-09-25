// @vitest-environment happy-dom
import { type AppSettings, DEFAULT_CURSOR_MODEL, DEFAULT_SETTINGS } from "@ddl/core";
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

  it("asks for risky actions with a daemon older than the approval policy, and keeps a sent one", () => {
    const { approvalPolicy: _policy, ...olderAgent } = DEFAULT_SETTINGS.agent;
    applySettings({ ...DEFAULT_SETTINGS, agent: olderAgent } as AppSettings);
    expect(getSettings().agent.approvalPolicy).toBe("ask_risky");
    applySettings({
      ...DEFAULT_SETTINGS,
      agent: { ...DEFAULT_SETTINGS.agent, approvalPolicy: "run_everything" },
    });
    expect(getSettings().agent.approvalPolicy).toBe("run_everything");
  });

  it("fills in the harness and Cursor model for a daemon older than the harness setting", () => {
    const { harness: _harness, cursorModel: _cursorModel, ...olderAgent } = DEFAULT_SETTINGS.agent;
    applySettings({
      ...DEFAULT_SETTINGS,
      agent: { ...olderAgent, model: "vendor/model-a" },
    } as AppSettings);
    expect(getSettings().agent).toMatchObject({
      harness: "pi",
      model: "vendor/model-a",
      cursorModel: DEFAULT_CURSOR_MODEL,
    });
  });

  it("keeps the harness and Cursor model the daemon sends", () => {
    applySettings({
      ...DEFAULT_SETTINGS,
      agent: { ...DEFAULT_SETTINGS.agent, harness: "cursor", cursorModel: "gpt-5.5" },
    });
    expect(getSettings().agent).toMatchObject({ harness: "cursor", cursorModel: "gpt-5.5" });
  });
});
