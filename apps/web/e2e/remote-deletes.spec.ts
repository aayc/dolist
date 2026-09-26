import { expect, type Page, test } from "./fixtures";
import { focusEditorEnd, noteTitle, openApp, waitForSaved } from "./helpers";

/**
 * Lines deleted outside the editor (another app, another device, a script through the API) stay
 * deleted: the editor never writes them back unless the user types them again. The note has a
 * line and the agent's line under it, the incident's shape (plain text: no task for the agent).
 */

const NOTE = "Rehearsal.md";
const LINE = "Rehearsal: count the bots";
const AGENT = "\t- Done: 11 bots %%agent:thr_1%%";

async function openNote(page: Page, content: string): Promise<void> {
  await openApp(page);
  await page.evaluate(
    ([path, text]) => window.__ddlMock!.createNote(path!, text!),
    [NOTE, content],
  );
  await page.evaluate((path) => window.__ddlDebug?.openNote(path), NOTE);
  await expect(noteTitle(page)).toHaveValue("Rehearsal");
  await expect(page.locator(".cm-content")).toContainText("Done: 11 bots");
}

function vault(page: Page): Promise<string | null> {
  return page.evaluate((path) => window.__ddlMock!.readNote(path), NOTE);
}

function editElsewhere(page: Page, content: string): Promise<void> {
  return page.evaluate(
    ([path, text]) => window.__ddlMock!.externalEdit(path!, text!),
    [NOTE, content],
  );
}

/** The window loses focus: every open note is flushed. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
}

test.describe("lines deleted elsewhere", () => {
  test("while the note is open and saved: shown, and typing never writes them back", async ({
    page,
  }) => {
    await openNote(page, `# Rehearsal\nNotes\n${LINE}\n${AGENT}`);
    await blur(page);
    await editElsewhere(page, "# Rehearsal\nNotes");
    await expect(page.locator(".cm-content")).not.toContainText("count the bots");
    await blur(page);
    await focusEditorEnd(page);
    await page.keyboard.type(" for Friday");
    await expect.poll(() => vault(page)).toBe("# Rehearsal\nNotes for Friday");
    await waitForSaved(page);
    await expect(page.locator(".cm-content")).not.toContainText("Done: 11 bots");
  });

  test("a line typed between them, with its save in flight, keeps only the typed line", async ({
    page,
  }) => {
    await openNote(page, `# Rehearsal\n${LINE}\n${AGENT}\nNotes`);
    await page.evaluate(() => window.__ddlDebug!.delayWrites(1500));
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("ask about the missing ones");
    // The save starts (300 ms after the last key) and is still on its way when the delete lands.
    await page.waitForTimeout(500);
    await editElsewhere(page, "# Rehearsal\nNotes");
    await expect
      .poll(() => vault(page), { timeout: 15_000 })
      .toBe("# Rehearsal\nask about the missing ones\nNotes");
    await waitForSaved(page);
    await expect(page.locator(".cm-content")).not.toContainText("count the bots");
    await expect(page.locator(".cm-content")).toContainText("ask about the missing ones");
    await expect(page.getByTestId("toast").filter({ hasText: "changed elsewhere" })).toHaveCount(0);
    const paths = await page.evaluate(() => window.__ddlMock!.listPaths());
    expect(paths.filter((path) => path.includes("conflict"))).toEqual([]);
  });
});
