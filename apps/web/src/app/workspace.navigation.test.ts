// @vitest-environment happy-dom
import { sleep } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockDaemonClient } from "../api/mock/mock-client";
import { useTabsStore } from "../state/tabs-store";
import { AgentActions } from "./agent-actions";
import { Workspace } from "./workspace";

function dailyPath(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Daily/${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
}

let client: MockDaemonClient;
let workspace: Workspace;

beforeEach(async () => {
  useTabsStore.setState({ tabs: [], active: null });
  client = new MockDaemonClient({ installHooks: false, persistSettings: false, speed: 1 });
  workspace = new Workspace(client, new AgentActions(client));
  workspace.applyTree(await client.getTree());
  await workspace.openToday();
  // Uncached notes take a moment to load, so keys arrive while a navigation is in flight.
  const read = client.readNote.bind(client);
  client.readNote = (path) => sleep(25).then(() => read(path));
});

afterEach(() => {
  client.disconnect();
});

describe("navigation while a note is still loading", () => {
  it("each Mod+Shift+P press walks one existing daily note further back", async () => {
    // The mock vault has daily notes for today, -1, -2 and -4.
    void workspace.openAdjacentDaily(-1);
    void workspace.openAdjacentDaily(-1);
    await workspace.openAdjacentDaily(-1);
    await sleep(100);
    expect(workspace.activePath).toBe(dailyPath(-4));
    expect(useTabsStore.getState().tabs).toEqual([dailyPath(-4)]);
  });

  it("the last key wins: today (cached) pressed while yesterday loads", async () => {
    void workspace.openAdjacentDaily(-1);
    await workspace.openToday();
    await sleep(100);
    expect(workspace.activePath).toBe(dailyPath(0));
  });

  it("a tab click wins over a note that is still loading", async () => {
    await workspace.openNote("Ideas.md", { newTab: true });
    workspace.activateTab(dailyPath(0));
    void workspace.openNote("Projects/Garden Redesign.md");
    workspace.activateTab("Ideas.md");
    await sleep(100);
    expect(workspace.activePath).toBe("Ideas.md");
    expect(useTabsStore.getState().tabs).toEqual([dailyPath(0), "Ideas.md"]);
  });
});
