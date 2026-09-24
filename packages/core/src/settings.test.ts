import { describe, expect, it } from "vitest";
import {
  type AgentHarnessKind,
  agentModel,
  DEFAULT_CURSOR_MODEL,
  DEFAULT_MODEL,
  DEFAULT_SETTINGS,
  mergeSettings,
} from "./settings";

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

describe("agent settings", () => {
  it("default to the Pi harness, with a Cursor model ready for the Cursor harness", () => {
    expect(DEFAULT_SETTINGS.agent).toMatchObject({
      harness: "pi",
      model: DEFAULT_MODEL,
      cursorModel: DEFAULT_CURSOR_MODEL,
      judgeModel: DEFAULT_MODEL,
    });
  });

  it("agentModel is the model of the configured harness", () => {
    const agent = { ...DEFAULT_SETTINGS.agent, model: "vendor/model-a", cursorModel: "gpt-5.5" };
    expect(agentModel(agent)).toBe("vendor/model-a");
    expect(agentModel({ ...agent, harness: "cursor" })).toBe("gpt-5.5");
    // A harness from a newer daemon that this build doesn't know counts as Pi.
    expect(agentModel({ ...agent, harness: "claude" as AgentHarnessKind })).toBe("vendor/model-a");
  });

  it("keep the harness defaults when an older payload doesn't carry them", () => {
    const { harness: _harness, cursorModel: _cursorModel, ...older } = DEFAULT_SETTINGS.agent;
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      agent: { ...older, model: "vendor/model-a" },
    });
    expect(merged.agent).toMatchObject({
      harness: "pi",
      model: "vendor/model-a",
      cursorModel: DEFAULT_CURSOR_MODEL,
    });
  });
});
