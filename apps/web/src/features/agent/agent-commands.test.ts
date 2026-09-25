import type { Thread } from "@ddl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Services } from "../../app/services";
import { createDefaultCommands } from "../../commands/default-commands";
import { formatHotkey } from "../../commands/hotkeys";
import { shortcutOf } from "../../commands/labels";
import { CommandRegistry } from "../../commands/registry";
import { initialAgentState } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import { ui, useUiStore } from "../../state/ui-store";
import { ensureAgentCommands } from "./agent-commands";

function withThread(status: Thread["status"]): void {
  const thread = { id: "thr_1", status, messages: [] } as unknown as Thread;
  useAgentStore.setState({ ...initialAgentState, details: { thr_1: thread } }, true);
}

describe("agent:stop", () => {
  afterEach(() => {
    useUiStore.setState({ rightOpen: false, rightView: { kind: "inbox" } });
  });

  function setup() {
    const agent = { cancel: vi.fn(async () => {}) };
    const services = { agent, commands: new CommandRegistry() } as unknown as Services;
    services.commands.registerAll(createDefaultCommands(services));
    ensureAgentCommands(services);
    ensureAgentCommands(services);
    return { agent, commands: services.commands };
  }

  it("applies only while the agent panel shows a thread its agent works on", () => {
    const { agent, commands } = setup();
    withThread("working");
    expect(commands.run("agent:stop")).toBe(false);
    ui.showThread("thr_1");
    expect(commands.run("agent:stop")).toBe(true);
    expect(agent.cancel).toHaveBeenCalledWith("thr_1");
    withThread("done");
    expect(commands.run("agent:stop")).toBe(false);
  });

  it("is named for its button and has a shortcut of its own", () => {
    const { commands } = setup();
    const stop = commands.get("agent:stop");
    expect(stop?.label).toBe("Stop");
    const shortcut = shortcutOf(stop, false);
    expect(shortcut && formatHotkey(shortcut, true)).toBe("⌘.");
    const others = commands
      .all()
      .filter((c) => c.id !== "agent:stop")
      .flatMap((c) => c.hotkeys ?? [])
      .map((h) => formatHotkey(h, true));
    expect(others).not.toContain("⌘.");
  });
});
