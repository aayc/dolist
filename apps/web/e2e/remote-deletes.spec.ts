import { type Browser, type Daemon, expect, type Page, test } from "./fixtures";
import { focusEditorEnd, noteTitle } from "./helpers";

/**
 * Lines deleted outside the editor stay deleted: the editor never writes them back unless the user
 * types them again. The incident's shape (content-hash versions, `vault.changed` batching, echo
 * attribution by client id): a note open in two editors, the agent's line under a line, then a
 * third client removing both through the API (a read, then a `baseVersion` write). Neither editor
 * may write them back, whether it was idle or had typing on its way.
 */

const LINE = "Rehearsal: count the bots";
const AGENT = "\t- Done: 11 bots %%agent:thr_1%%";

interface Note {
  content: string;
  version: string;
}

async function openEditor(browser: Browser, daemon: Daemon, path: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: daemon.url,
    viewport: { width: 1400, height: 900 },
  });
  const page = await context.newPage();
  await page.goto("/?debug=1");
  await page.waitForFunction(() =>
    window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
  );
  await page.evaluate((notePath) => window.__ddlDebug!.openNote(notePath), path);
  await expect(noteTitle(page)).toHaveValue(path.replace(/\.md$/, ""));
  return page;
}

/** The notes API, as another client (a script, another app) calls it. */
async function read(daemon: Daemon, path: string): Promise<Note> {
  return (await daemon.api<Note>("GET", `/api/notes/${encodeURIComponent(path)}`)).body;
}

async function write(daemon: Daemon, path: string, content: string, baseVersion: string | null) {
  const { status } = await daemon.api("PUT", `/api/notes/${encodeURIComponent(path)}`, {
    content,
    baseVersion,
  });
  expect(status).toBeLessThan(300);
}

/** The incident's cleanup: read the note, then write it back without the two lines. */
async function removeTheLines(daemon: Daemon, path: string): Promise<void> {
  const note = await read(daemon, path);
  const content = note.content
    .split("\n")
    .filter((line) => line !== LINE && line !== AGENT)
    .join("\n");
  await write(daemon, path, content, note.version);
}

test("two idle editors: a delete through the API sticks, and typing afterwards keeps it", async ({
  browser,
  daemon,
}) => {
  const path = "Merge race idle.md";
  await write(daemon, path, `# Plan\nNotes\n${LINE}`, null);
  const web = await openEditor(browser, daemon, path);
  const other = await openEditor(browser, daemon, path);
  // The agent adds its line under the line; both editors show it.
  const before = await read(daemon, path);
  await write(daemon, path, `${before.content}\n${AGENT}`, before.version);
  for (const page of [web, other]) {
    await expect(page.locator(".cm-content")).toContainText("Done: 11 bots");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  }

  await removeTheLines(daemon, path);
  for (const page of [web, other]) {
    await expect(page.locator(".cm-content")).not.toContainText("count the bots");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  }
  await focusEditorEnd(web);
  await web.keyboard.type(" for Friday");
  await expect
    .poll(async () => (await read(daemon, path)).content)
    .toBe("# Plan\nNotes for Friday");
  await expect(other.locator(".cm-content")).toContainText("Notes for Friday");
  await focusEditorEnd(other);
  await other.keyboard.type("!");
  await expect
    .poll(async () => (await read(daemon, path)).content)
    .toBe("# Plan\nNotes for Friday!");
  await expect(web.locator(".cm-content")).toContainText("Notes for Friday!");
  await expect(web.locator(".cm-content")).not.toContainText("count the bots");
});

test("an editor typing between the lines while they're deleted keeps only its own line", async ({
  browser,
  daemon,
}) => {
  const path = "Merge race typing.md";
  await write(daemon, path, `# Plan\n${LINE}\n${AGENT}\nNotes`, null);
  const web = await openEditor(browser, daemon, path);
  const other = await openEditor(browser, daemon, path);
  await expect(web.locator(".cm-content")).toContainText("Done: 11 bots");
  await web.evaluate(() => window.__ddlDebug!.delayWrites(1500));
  await web.locator(".cm-content").click();
  await web.keyboard.press("ControlOrMeta+Home");
  await web.keyboard.press("ArrowDown");
  await web.keyboard.press("End");
  await web.keyboard.press("Enter");
  await web.keyboard.type("ask about the missing ones");
  // The save starts (300 ms after the last key) and is still on its way when the delete lands.
  await web.waitForTimeout(500);
  await removeTheLines(daemon, path);

  const expected = "# Plan\nask about the missing ones\nNotes";
  await expect
    .poll(async () => (await read(daemon, path)).content, { timeout: 15_000 })
    .toBe(expected);
  for (const page of [web, other]) {
    await expect(page.locator(".cm-content")).toContainText("ask about the missing ones");
    await expect(page.locator(".cm-content")).not.toContainText("count the bots");
  }
  await expect(web.getByTestId("toast").filter({ hasText: "changed elsewhere" })).toHaveCount(0);
  expect((await daemon.list()).filter((file) => file.includes("conflict"))).toEqual([]);
});
