/**
 * The incident, against the real daemon (content-hash versions, `vault.changed` batching, echo
 * attribution by client id): a note open in two editors, the agent's line under a line, then a
 * third client removing both through the API (a read, then a `baseVersion` write). Neither editor
 * may write them back, whether it was idle or had typing on its way.
 * Run with `pnpm --filter @ddl/web e2e:fullstack`.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";
import { focusEditorEnd, noteTitle } from "../helpers";

test.describe.configure({ mode: "serial" });

const LINE = "Rehearsal: count the bots";
const AGENT = "\t- Done: 11 bots %%agent:thr_1%%";

interface Note {
  content: string;
  version: string;
}

async function openEditor(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  // perf=1 installs the debug hooks (open a note, hold writes).
  await page.goto("/?perf=1");
  await page.waitForFunction(() =>
    window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
  );
  return page;
}

/** The daemon's notes API, as another client (a script, another app) would call it. */
async function api(
  page: Page,
  path: string,
  body?: { content: string; baseVersion: string | null },
) {
  return page.evaluate(
    async ([notePath, payload]) => {
      const token = document.querySelector<HTMLMetaElement>('meta[name="ddl-token"]')?.content;
      const response = await fetch(`/api/notes/${encodeURIComponent(notePath!)}`, {
        method: payload ? "PUT" : "GET",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      return (await response.json()) as Note;
    },
    [path, body] as const,
  );
}

async function show(page: Page, path: string): Promise<void> {
  await page.evaluate((notePath) => window.__ddlDebug!.openNote(notePath), path);
  await expect(noteTitle(page)).toHaveValue(path.replace(/\.md$/, ""));
}

/** The incident's cleanup: read the note, then write it back without the two lines. */
async function removeTheLines(page: Page, path: string): Promise<void> {
  const note = await api(page, path);
  const content = note.content
    .split("\n")
    .filter((line) => line !== LINE && line !== AGENT)
    .join("\n");
  await api(page, path, { content, baseVersion: note.version });
}

test("two idle editors: a delete through the API sticks, and typing afterwards keeps it", async ({
  browser,
}) => {
  const path = "Merge race idle.md";
  const web = await openEditor(browser);
  const other = await openEditor(browser);
  await api(web, path, { content: `# Plan\nNotes\n${LINE}`, baseVersion: null });
  await show(web, path);
  await show(other, path);
  // The agent adds its line under the line; both editors show it.
  const before = await api(web, path);
  await api(web, path, { content: `${before.content}\n${AGENT}`, baseVersion: before.version });
  for (const page of [web, other]) {
    await expect(page.locator(".cm-content")).toContainText("Done: 11 bots");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  }

  await removeTheLines(web, path);
  for (const page of [web, other]) {
    await expect(page.locator(".cm-content")).not.toContainText("count the bots");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  }
  await focusEditorEnd(web);
  await web.keyboard.type(" for Friday");
  await expect.poll(async () => (await api(web, path)).content).toBe("# Plan\nNotes for Friday");
  await expect(other.locator(".cm-content")).toContainText("Notes for Friday");
  await focusEditorEnd(other);
  await other.keyboard.type("!");
  await expect.poll(async () => (await api(web, path)).content).toBe("# Plan\nNotes for Friday!");
  await expect(web.locator(".cm-content")).toContainText("Notes for Friday!");
  await expect(web.locator(".cm-content")).not.toContainText("count the bots");
});

test("an editor typing between the lines while they're deleted keeps only its own line", async ({
  browser,
}) => {
  const path = "Merge race typing.md";
  const web = await openEditor(browser);
  const other = await openEditor(browser);
  await api(web, path, { content: `# Plan\n${LINE}\n${AGENT}\nNotes`, baseVersion: null });
  await show(web, path);
  await show(other, path);
  await expect(web.locator(".cm-content")).toContainText("Done: 11 bots");
  await web.evaluate(() => window.__ddlDebug!.delayWrites(1500));
  await web.locator(".cm-content").click();
  await web.keyboard.press("ControlOrMeta+Home");
  await web.keyboard.press("ArrowDown");
  await web.keyboard.press("End");
  await web.keyboard.press("Enter");
  await web.keyboard.type("ask about the missing ones");
  await web.waitForTimeout(500);
  await removeTheLines(other, path);

  const expected = "# Plan\nask about the missing ones\nNotes";
  await expect.poll(async () => (await api(web, path)).content, { timeout: 15_000 }).toBe(expected);
  for (const page of [web, other]) {
    await expect(page.locator(".cm-content")).toContainText("ask about the missing ones");
    await expect(page.locator(".cm-content")).not.toContainText("count the bots");
  }
  await expect(web.getByTestId("toast").filter({ hasText: "changed elsewhere" })).toHaveCount(0);
});
