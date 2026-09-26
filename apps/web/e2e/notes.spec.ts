import { expect, test } from "./fixtures";
import { expectDailyNote, focusEditorEnd, noteTitle, openApp, waitForSaved } from "./helpers";

test.describe("notes, palette and settings", () => {
  test("quick switcher opens notes and Mod+Enter creates one", async ({ page, daemon }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+O");
    const input = page.getByTestId("switcher-input");
    await expect(input).toBeFocused();
    await input.fill("garden");
    await expect(page.getByTestId("switcher-item").first()).toContainText("Garden Redesign");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("switcher")).toBeHidden();
    await expect(noteTitle(page)).toHaveValue("Garden Redesign");

    await page.keyboard.press("ControlOrMeta+O");
    await page.getByTestId("switcher-input").fill("Weekend plans");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(noteTitle(page)).toHaveValue("Weekend plans");
    await expect(
      page.locator('[data-testid="explorer-item"][data-path="Weekend plans.md"]'),
    ).toBeVisible();
    await expect.poll(() => daemon.read("Weekend plans.md")).toBe("");
  });

  test("command palette lists hotkeys, runs commands and closes on Escape", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+P");
    const palette = page.getByTestId("palette");
    await expect(palette).toBeVisible();
    await page.getByTestId("palette-input").fill("today");
    const item = page.getByTestId("palette-item").first();
    await expect(item).toContainText("Open today's daily note");
    // One keycap per key: ⇧ ⌘ D, or Ctrl Shift D.
    await expect(item.locator(".keycaps kbd")).toHaveText([/./, /./, "D"]);

    await page.getByTestId("palette-input").fill("agent panel");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.getByTestId("right-panel")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+P");
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("create, rename and delete a note", async ({ page, daemon }) => {
    await openApp(page);
    await page.getByTestId("explorer-new-note").click();
    const title = noteTitle(page);
    await expect(title).toBeFocused();
    await expect(title).toHaveValue("Untitled");
    await title.fill("Shopping list");
    await title.press("Enter");
    const created = page.locator('[data-testid="explorer-item"][data-path="Shopping list.md"]');
    await expect(created).toBeVisible();
    await expect(page.getByTestId("tab").filter({ hasText: "Shopping list" })).toBeVisible();

    await created.click({ button: "right" });
    await page.getByTestId("context-menu").getByText("Rename").click();
    const rename = page.getByTestId("explorer-rename");
    await expect(rename).toBeFocused();
    await rename.fill("Groceries");
    await rename.press("Enter");
    const renamed = page.locator('[data-testid="explorer-item"][data-path="Groceries.md"]');
    await expect(renamed).toBeVisible();
    await expect(created).toHaveCount(0);
    await expect(title).toHaveValue("Groceries");
    await expect.poll(async () => (await daemon.list()).includes("Groceries.md")).toBe(true);

    await renamed.click({ button: "right" });
    await page.getByTestId("context-menu").getByText("Delete").click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-accept").click();
    await expect(renamed).toHaveCount(0);
    await expect(page.getByTestId("tab").filter({ hasText: "Groceries" })).toHaveCount(0);
    await expect.poll(async () => (await daemon.list()).includes("Groceries.md")).toBe(false);
  });

  test("tabs: open in new tab, switch, close with the close button", async ({ page }) => {
    await openApp(page);
    await page
      .locator('[data-testid="explorer-item"][data-path="Ideas.md"]')
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(page.getByTestId("tab")).toHaveCount(2);
    await expect(noteTitle(page)).toHaveValue("Ideas");
    await page.getByTestId("tab").first().click();
    await expectDailyNote(page);
    await page.getByTestId("tab").filter({ hasText: "Ideas" }).getByTestId("tab-close").click();
    await expect(page.getByTestId("tab")).toHaveCount(1);
  });

  test("settings changes apply immediately", async ({ page, daemon }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByTestId("settings-nav-editor").click();
    await page.getByTestId("setting-vim").click();
    await expect(page.getByTestId("status-vim")).toBeVisible();

    const fontSize = page.getByTestId("setting-font-size");
    await fontSize.fill("20");
    await fontSize.press("Enter");
    await expect(page.locator(".cm-editor")).toHaveCSS("font-size", "20px");

    await page.getByTestId("settings-nav-daily").click();
    await page.getByTestId("setting-daily-folder").fill("Journal");
    await expect(page.getByTestId("daily-preview")).toContainText("Journal/");

    await page.getByTestId("settings-nav-about").click();
    await expect(page.getByTestId("about-list")).toContainText(daemon.url);
  });

  test("search finds text across the vault and opens the hit", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+Shift+F");
    const input = page.getByTestId("search-input");
    await expect(input).toBeFocused();
    await input.fill("cedar");
    const hit = page.getByTestId("search-hit").first();
    await expect(hit).toContainText("cedar");
    await hit.click();
    await expect(noteTitle(page)).toHaveValue("Garden Redesign");
    // Regular notes keep their editable title and folder breadcrumb.
    await expect(page.locator(".note-breadcrumb")).toHaveText("Projects");
  });

  test("a conflicting external edit keeps local text and saves the other version as a copy", async ({
    page,
    daemon,
  }) => {
    await openApp(page);
    await page.evaluate(() => window.__ddlDebug?.openNote("Ideas.md"));
    await expect(noteTitle(page)).toHaveValue("Ideas");
    await focusEditorEnd(page);
    await page.keyboard.type(" local change");
    await daemon.write("Ideas.md", "# Ideas\n\nRemote rewrite");

    const toast = page.getByTestId("toast").filter({ hasText: "changed elsewhere" });
    await expect(toast).toBeVisible();
    await expect.poll(() => daemon.read("Ideas (conflict).md")).toBe("# Ideas\n\nRemote rewrite");
    await expect.poll(() => daemon.read("Ideas.md")).toContain("local change");
    await expect(page.locator(".cm-content")).toContainText("local change");
    await waitForSaved(page);

    await toast.getByTestId("toast-body").click();
    await expect(noteTitle(page)).toHaveValue("Ideas (conflict)");
  });

  test("external edits update an open note without local changes", async ({ page, daemon }) => {
    await openApp(page);
    await page.evaluate(() => window.__ddlDebug?.openNote("Ideas.md"));
    await expect(noteTitle(page)).toHaveValue("Ideas");
    await daemon.write("Ideas.md", "# Ideas\n\nEdited elsewhere");
    await expect(page.locator(".cm-content")).toContainText("Edited elsewhere");
  });
});
