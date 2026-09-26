import { expect, test } from "./fixtures";
import { dailyHeading, dailyPath, dailyTitle, expectDailyNote, isoDate, openApp } from "./helpers";

test.describe("startup and daily notes", () => {
  test("loads and opens today's daily note", async ({ page }) => {
    await openApp(page);
    await expectDailyNote(page);
    // The title is the date, not the file name, and there is no "Daily" breadcrumb.
    await expect(dailyHeading(page)).toHaveText(dailyTitle());
    await expect(page.locator(".note-breadcrumb")).toHaveCount(0);
    await expect(page.getByTestId("daily-header").getByText("Today")).toBeVisible();
    await expect(page.getByTestId("tab")).toHaveCount(1);
    await expect(page.getByTestId("tab")).toHaveAttribute("data-path", dailyPath());
    await expect(page.getByTestId("tab")).toContainText(isoDate());
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(
      page.locator(`[data-testid="explorer-item"][data-path="${dailyPath()}"]`),
    ).toHaveAttribute("aria-selected", "true");
    // Quiet status bar: nothing for "connected" or "saved".
    await expect(page.getByTestId("status-agent")).toBeVisible();
    await expect(page.getByTestId("status-connection")).toHaveCount(0);
    await expect(page.getByTestId("status-bar")).toHaveAttribute("data-save-state", "saved");
    await expect(page.getByTestId("status-save")).toHaveCount(0);
  });

  test("Mod+Shift+P walks back through existing daily notes; Mod+Shift+D returns to today", async ({
    page,
  }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expectDailyNote(page, -1);
    await expect(dailyHeading(page)).toHaveText(dailyTitle(-1));
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expectDailyNote(page, -2);
    // The day before doesn't exist: "previous" means the nearest existing daily note.
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expectDailyNote(page, -4);
    await expect(page.getByTestId("daily-today")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+Shift+D");
    await expectDailyNote(page);
    // Navigation replaces the active tab (Obsidian semantics).
    await expect(page.getByTestId("tab")).toHaveCount(1);
  });

  test("daily header arrows navigate between existing notes", async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId("daily-next")).toBeDisabled();
    await page.getByTestId("daily-prev").click();
    await expectDailyNote(page, -1);
    await page.getByTestId("daily-next").click();
    await expectDailyNote(page);
  });

  test("renaming a daily note (its title isn't editable) happens in the file explorer", async ({
    page,
  }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+P");
    await page.getByTestId("palette-input").fill("Rename current note");
    await page.keyboard.press("Enter");
    const rename = page.getByTestId("explorer-rename");
    await expect(rename).toBeFocused();
    await expect(rename).toHaveValue(isoDate());
    await page.keyboard.press("Escape");
    await expect(rename).toHaveCount(0);
    await expectDailyNote(page);
  });

  test("Mod+Shift+D creates today's note from the template when it is missing", async ({
    page,
    daemon,
  }) => {
    await openApp(page);
    await daemon.remove(dailyPath());
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+D");
    await expectDailyNote(page);
    await expect.poll(() => daemon.read(dailyPath())).toBe("- [ ] ");
  });

  test("theme choice persists across reloads without a flash", async ({ page }) => {
    await openApp(page);
    const initial = await page.evaluate(() => document.documentElement.dataset.theme);
    const target = initial === "dark" ? "light" : "dark";
    await page.keyboard.press("ControlOrMeta+,");
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.getByTestId(`theme-${target}`).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", target);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-modal")).toBeHidden();

    await page.reload({ waitUntil: "domcontentloaded" });
    // Set by the inline boot script, before the app bundle runs.
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(target);
    await expect(dailyHeading(page)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", target);
  });
});
