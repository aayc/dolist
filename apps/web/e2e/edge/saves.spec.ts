import { expect, test } from "../fixtures";
import { dailyPath, noteTitle, openApp } from "../helpers";
import {
  caretToEnd,
  collectErrors,
  delayWrites,
  expectSaved,
  explorerItem,
  tab,
} from "./edge-helpers";

test.describe("saves in flight", () => {
  test("switching tabs while a save is in flight keeps every note's text", async ({
    page,
    daemon,
  }) => {
    const errors = collectErrors(page);
    await openApp(page);
    const today = dailyPath();
    const initial = (await daemon.read(today)) ?? "";
    await delayWrites(page, 700);

    await caretToEnd(page);
    await page.keyboard.type("alpha");
    await page.waitForTimeout(450); // debounce elapsed: the save is now in flight
    await explorerItem(page, "Ideas.md").click({ modifiers: ["ControlOrMeta"] });
    await expect(noteTitle(page)).toHaveValue("Ideas");
    await caretToEnd(page);
    await page.keyboard.type(" beta");
    await tab(page, today).click();
    await caretToEnd(page);
    await page.keyboard.type(" gamma");
    // Bounce between the tabs while writes are still held.
    for (let i = 0; i < 6; i++) await tab(page, i % 2 ? today : "Ideas.md").click();
    await delayWrites(page, 0);

    await expect.poll(() => daemon.read(today), { timeout: 15_000 }).toBe(`${initial}alpha gamma`);
    await expect.poll(() => daemon.read("Ideas.md")).toMatch(/Small steps every day\. beta$/);
    await expectSaved(page);
    expect((await daemon.list()).filter((p) => p.includes("(conflict"))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("unsaved text is flushed on pagehide / beforeunload / hidden, before the debounce", async ({
    page,
    daemon,
  }) => {
    await openApp(page);
    const today = dailyPath();
    const initial = (await daemon.read(today)) ?? "";
    for (const [i, event] of ["pagehide", "beforeunload", "visibilitychange"].entries()) {
      await caretToEnd(page);
      await page.keyboard.type(`w${i}`);
      await page.evaluate((name) => {
        if (name === "visibilitychange") {
          Object.defineProperty(document, "visibilityState", {
            value: "hidden",
            configurable: true,
          });
          document.dispatchEvent(new Event("visibilitychange"));
          Object.defineProperty(document, "visibilityState", {
            value: "visible",
            configurable: true,
          });
        } else {
          window.dispatchEvent(new Event(name));
        }
      }, event);
      // Well inside the 300 ms autosave debounce: only the flush can have written this.
      await expect
        .poll(() => daemon.read(today), { timeout: 250, intervals: [20] })
        .toBe(initial + ["w0", "w1", "w2"].slice(0, i + 1).join(""));
    }
  });

  test("the status bar shows a pending save, and nothing once the note is saved", async ({
    page,
  }) => {
    await openApp(page);
    await delayWrites(page, 800);
    await caretToEnd(page);
    await page.keyboard.type("quiet");
    const save = page.getByTestId("status-save");
    await expect(save).toBeVisible();
    await expect(save).toHaveAttribute("data-state", "saving");
    await expect(save).toHaveText("Saving…");
    await expectSaved(page);
    await expect(save).toHaveCount(0);
  });

  test("text typed while a save is in flight is saved when the window loses focus", async ({
    page,
    daemon,
  }) => {
    await openApp(page);
    const today = dailyPath();
    const initial = (await daemon.read(today)) ?? "";
    await delayWrites(page, 500);
    await caretToEnd(page);
    await page.keyboard.type("first");
    await page.waitForTimeout(400);
    await page.keyboard.type(" second");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await delayWrites(page, 0);
    await expect.poll(() => daemon.read(today), { timeout: 10_000 }).toBe(`${initial}first second`);
  });
});

test.describe("deleting open notes", () => {
  test("a note can't be opened twice; deleting it closes its tab and shows the neighbour", async ({
    page,
    daemon,
  }) => {
    const errors = collectErrors(page);
    await openApp(page);
    const ideas = explorerItem(page, "Ideas.md");
    await ideas.click({ modifiers: ["ControlOrMeta"] });
    await ideas.click({ modifiers: ["ControlOrMeta"] });
    await ideas.click({ button: "middle" });
    await expect(page.getByTestId("tab")).toHaveCount(2);
    await expect(noteTitle(page)).toHaveValue("Ideas");

    await ideas.click({ button: "right" });
    await page.getByTestId("context-menu").getByText("Delete").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("tab")).toHaveCount(1);
    await expect(page.getByTestId("tab")).toHaveAttribute("data-path", dailyPath());
    await expect(page.locator(".cm-content")).not.toContainText("Small steps every day");
    await expect.poll(() => daemon.read("Ideas.md")).toBeNull();
    expect(errors).toEqual([]);
  });

  test("deleting a background tab keeps the active note", async ({ page }) => {
    await openApp(page);
    const other = "Projects/Home Office.md";
    await page.getByTestId("explorer-item").filter({ hasText: "Projects" }).first().click();
    await explorerItem(page, other).click({ modifiers: ["ControlOrMeta"] });
    await tab(page, dailyPath()).click();
    await explorerItem(page, other).click({ button: "right" });
    await page.getByTestId("context-menu").getByText("Delete").click();
    await page.getByTestId("confirm-accept").click();
    await expect(tab(page, other)).toHaveCount(0);
    await expect(page.getByTestId("tab")).toHaveAttribute("data-path", dailyPath());
  });

  test("deleted elsewhere: unsaved text is written back, a clean note closes", async ({
    page,
    daemon,
  }) => {
    await openApp(page);
    await page.evaluate(() =>
      (
        window as unknown as { __ddlDebug: { openNote(p: string, n: boolean): Promise<boolean> } }
      ).__ddlDebug.openNote("Ideas.md", true),
    );
    await expect(noteTitle(page)).toHaveValue("Ideas");
    let writing = 0;
    page.on("request", (request) => {
      if (request.method() === "PUT") writing++;
    });
    const done = (request: { method(): string }) => {
      if (request.method() === "PUT") writing--;
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    await delayWrites(page, 300);
    await caretToEnd(page);
    await page.keyboard.type(" keep this");
    await daemon.remove("Ideas.md");
    await delayWrites(page, 0);
    await expect(
      page.getByTestId("toast").filter({ hasText: "was deleted elsewhere" }),
    ).toBeVisible();
    await expect.poll(() => daemon.read("Ideas.md")).toMatch(/ keep this$/);
    await expect(tab(page, "Ideas.md")).toHaveCount(1);

    // Now clean (the write-back and the held save have both landed): another deletion closes the tab.
    await expectSaved(page);
    await expect.poll(() => writing).toBe(0);
    await daemon.remove("Ideas.md");
    await expect(tab(page, "Ideas.md")).toHaveCount(0);
    await expect(
      page
        .getByTestId("toast")
        .filter({ hasText: "“Ideas” was deleted" })
        .filter({ hasNotText: "elsewhere" }),
    ).toBeVisible();
  });
});
