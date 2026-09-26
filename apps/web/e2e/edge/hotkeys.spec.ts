import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { dailyPath, expectDailyNote, openApp } from "../helpers";
import { collectErrors, type EdgeWindow } from "./edge-helpers";

// The mock vault has daily notes for today, -1, -2 and -4 days.

async function expectShowing(page: Page, days: number): Promise<void> {
  await expectDailyNote(page, days);
  await expect(page.getByTestId("tab")).toHaveCount(1);
  await expect(page.getByTestId("tab")).toHaveAttribute("data-path", dailyPath(days));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as EdgeWindow).__ddlDebug.activePath()))
    .toBe(dailyPath(days));
}

test.describe("daily note hotkeys under rapid repetition", () => {
  test("mashing Mod+Shift+P walks back one existing note per press and stops at the oldest", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openApp(page);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ControlOrMeta+Shift+P");
    await expectShowing(page, -4);
    // Past the oldest note: stays there and says so.
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await expect(
      page.getByTestId("toast").filter({ hasText: "No previous daily note" }).first(),
    ).toBeVisible();
    await expectShowing(page, -4);
    expect(errors).toEqual([]);
  });

  test("mashing Mod+Shift+D always lands on today in a single tab", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+Shift+P");
    for (let i = 0; i < 8; i++) await page.keyboard.press("ControlOrMeta+Shift+D");
    await expectShowing(page, 0);
    expect(errors).toEqual([]);
  });

  test("interleaved previous/next/today keys end on a consistent note", async ({ page }) => {
    const errors = collectErrors(page);
    await openApp(page);
    const keys = ["P", "P", "D", "P", "N", "P", "P", "P", "N", "N"];
    for (const k of keys) await page.keyboard.press(`ControlOrMeta+Shift+${k}`);
    // today → -1 → -2 → today → -1 → today → -1 → -2 → -4 → -2 → -1
    await expectShowing(page, -1);
    await expect(page.locator(".cm-content")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("auto-repeat (key held down) doesn't skip or duplicate", async ({ page }) => {
    await openApp(page);
    // A held key sends repeated keydowns without keyups.
    await page.keyboard.down("ControlOrMeta");
    await page.keyboard.down("Shift");
    for (let i = 0; i < 3; i++) await page.keyboard.down("KeyP");
    await page.keyboard.up("KeyP");
    await page.keyboard.up("Shift");
    await page.keyboard.up("ControlOrMeta");
    await expectShowing(page, -4);
  });
});
