// @vitest-environment happy-dom
import type { MarkdownEditor } from "@ddl/editor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "../api/client";
import { useTabsStore } from "../state/tabs-store";
import { AgentActions } from "./agent-actions";
import { Workspace } from "./workspace";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TODAY = "Daily/2026-09-24.md";

/** The notes the workspace reads and writes; anything else it asks for is refused. */
function notesClient(saved: Map<string, string>): DaemonClient {
  let version = 0;
  const note = (path: string) => ({
    path,
    content: saved.get(path) ?? "",
    version: String(version),
    mtime: 0,
  });
  const client: Partial<DaemonClient> = {
    clientId: "web_test",
    send: () => {},
    getTree: async () => ({ vaultName: "vault", entries: [] }),
    getDailyNote: async () => ({ ...note(TODAY), date: "2026-09-24", created: false }),
    readNote: async (path) => note(path),
    writeNote: async (path, body) => {
      saved.set(path, body.content);
      return { path, version: String(++version), mtime: 0 };
    },
  };
  return new Proxy(client, {
    get: (target, key: string) =>
      key in target ? target[key as keyof DaemonClient] : () => Promise.reject(new Error(key)),
  }) as DaemonClient;
}

let saved: Map<string, string>;
let workspace: Workspace;
let host: HTMLElement;

/** Types at the end of the first line, as a keystroke would (a user event). */
function typeOnFirstLine(text: string): void {
  const editor = (workspace.editor as unknown as { editor: MarkdownEditor }).editor;
  const at = editor.view.state.doc.line(1).to;
  editor.view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.type" });
}

beforeEach(async () => {
  useTabsStore.setState({ tabs: [], active: null });
  saved = new Map([[TODAY, "- [ ] "]]);
  const client = notesClient(saved);
  workspace = new Workspace(client, new AgentActions(client));
  host = document.createElement("div");
  document.body.append(host);
  workspace.mountEditor(host);
  await workspace.openToday();
});

afterEach(() => {
  workspace.unmountEditor();
  host.remove();
});

describe("the editor mounted anew", () => {
  it("shows unsaved typing again (Fast Refresh, layout), and saves it", async () => {
    typeOnFirstLine(" draft");
    const typed = workspace.editor.getDocument()!;
    workspace.unmountEditor();
    workspace.mountEditor(host);
    expect(workspace.editor.getDocument()).toBe(typed);
    await sleep(400);
    expect(saved.get(TODAY)).toBe(typed);
    expect(workspace.editor.getDocument()).toBe(typed);
  });
});
