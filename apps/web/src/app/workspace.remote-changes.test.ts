// @vitest-environment happy-dom
import { sleep } from "@ddl/core";
import type { MarkdownEditor } from "@ddl/editor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockDaemonClient } from "../api/mock/mock-client";
import { useTabsStore } from "../state/tabs-store";
import { AgentActions } from "./agent-actions";
import { Workspace } from "./workspace";

let client: MockDaemonClient;
let workspace: Workspace;
let host: HTMLElement;
let path: string;

/** Types at the end of the first line, as a keystroke would (a user event). */
function typeOnFirstLine(text: string): void {
  const editor = (workspace.editor as unknown as { editor: MarkdownEditor }).editor;
  const at = editor.view.state.doc.line(1).to;
  editor.view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" });
}

function vault(): string {
  return window.__ddlMock!.readNote(path)!;
}

beforeEach(async () => {
  useTabsStore.setState({ tabs: [], active: null });
  client = new MockDaemonClient({ installHooks: true, persistSettings: false, speed: 1 });
  client.onEvent((event) => {
    if (event.type === "vault.changed") workspace.handleVaultChanged(event);
  });
  client.connect();
  workspace = new Workspace(client, new AgentActions(client));
  workspace.applyTree(await client.getTree());
  host = document.createElement("div");
  document.body.append(host);
  workspace.mountEditor(host);
  await workspace.openToday();
  path = workspace.activePath!;
});

afterEach(() => {
  workspace.unmountEditor();
  host.remove();
  client.disconnect();
});

describe("the editor and changes made elsewhere", () => {
  it("shows unsaved typing again when the editor is mounted anew (Fast Refresh, layout)", async () => {
    typeOnFirstLine(" draft");
    const typed = workspace.editor.getDocument()!;
    workspace.unmountEditor();
    workspace.mountEditor(host);
    expect(workspace.editor.getDocument()).toBe(typed);
    await sleep(400);
    expect(vault()).toBe(typed);
    expect(workspace.editor.getDocument()).toBe(typed);
  });

  it("an agent line, then an external delete while open and clean: never written back", async () => {
    const task = "- [ ] Rehearsal: count the bots";
    const result = "\t- Done: 11 bots %%agent:thr_1%%";
    window.__ddlMock!.externalEdit(path, `# Thursday\n${task}\n${result}\nNotes`);
    await sleep(50);
    await workspace.notes.flushAll(); // the window loses focus
    window.__ddlMock!.externalEdit(path, "# Thursday\nNotes");
    await sleep(50);
    expect(workspace.editor.getDocument()).toBe("# Thursday\nNotes");
    await workspace.notes.flushAll();
    typeOnFirstLine(" !");
    await sleep(400);
    expect(vault()).toBe("# Thursday !\nNotes");
    expect(workspace.editor.getDocument()).toBe("# Thursday !\nNotes");
  });
});
