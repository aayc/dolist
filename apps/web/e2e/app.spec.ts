import { expect, test } from "@playwright/test";
import { dailyPath, isoDate, noteTitle, openApp } from "./helpers";

test.describe("startup and daily notes", () => {
  test("loads and opens today's daily note", async ({ page }) => {
    await openApp(page);
    await expect(noteTitle(page)).toHaveValue(isoDate());
    await expect(page.getByTestId("tab")).toHaveCount(1);
    await expect(page.getByTestId("tab")).toHaveAttribute("data-path", dailyPath());
    const weekday = new Date().toLocaleDateString("en-US", { weekday: "long" });
    await expect(page.getByTestId("daily-header")).toContainText(weekday);
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(
      page.locator(`[data-testid="explorer-item"][data-path="${dailyPath()}"]`),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("status-connection")).toHaveAttribute("data-state", "online");
    await expect(page.getByTestId("status-save")).toHaveAttribute("data-state", "saved");
  });

  test("Mod+Shift+P walks back through existing daily notes; Mod+Shift+D returns to today", async ({
    page,
  }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expect(noteTitle(page)).toHaveValue(isoDate(-1));
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expect(noteTitle(page)).toHaveValue(isoDate(-2));
    // The day before doesn't exist: "previous" means the nearest existing daily note.
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expect(noteTitle(page)).toHaveValue(isoDate(-4));
    await expect(page.getByTestId("daily-today")).toBeVisible();

    await page.keyboard.press("ControlOrMeta+Shift+D");
    await expect(noteTitle(page)).toHaveValue(isoDate());
    // Navigation replaces the active tab (Obsidian semantics).
    await expect(page.getByTestId("tab")).toHaveCount(1);
  });

  test("daily header arrows navigate between existing notes", async ({ page }) => {
    await openApp(page);
    await expect(page.getByTestId("daily-next")).toBeDisabled();
    await page.getByTestId("daily-prev").click();
    await expect(noteTitle(page)).toHaveValue(isoDate(-1));
    await page.getByTestId("daily-next").click();
    await expect(noteTitle(page)).toHaveValue(isoDate());
  });

  test("Mod+Shift+D creates today's note from the template when it is missing", async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate((path) => window.__ddlMock?.deleteNote(path), dailyPath());
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+D");
    await expect(noteTitle(page)).toHaveValue(isoDate());
    await expect
      .poll(() => page.evaluate((path) => window.__ddlMock?.readNote(path), dailyPath()))
      .toBe("- [ ] ");
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
    await expect(noteTitle(page)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", target);
  });
});
