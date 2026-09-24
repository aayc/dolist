import { expect, type Page, test } from "@playwright/test";
import { openApp } from "./helpers";

async function openAgentSettings(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("settings-nav-agent").click();
}

/** Replaces a text field's contents with the real keyboard, then leaves the field (which saves). */
async function retype(page: Page, testId: string, text: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press("Tab");
}

async function reloadApp(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("note-title")).toBeVisible();
}

test.describe("agent settings", () => {
  test("the harness and each harness's model persist across reloads", async ({ page }) => {
    await openApp(page);
    await openAgentSettings(page);
    const pi = page.getByRole("radio", { name: "Pi · OpenRouter model" });
    const cursor = page.getByRole("radio", { name: "Cursor CLI · your Cursor account" });
    const openRouterModel = page.getByTestId("setting-model");
    const cursorModel = page.getByTestId("setting-cursor-model");
    await expect(pi).toBeChecked();
    await expect(openRouterModel).toHaveValue("mock/scripted-agent");
    await expect(cursorModel).toHaveCount(0);

    await page.getByTestId("setting-harness-cursor").click();
    await expect(cursor).toBeChecked();
    await expect(openRouterModel).toHaveCount(0);
    await expect(cursorModel).toHaveValue("claude-opus-5-5");
    await retype(page, "setting-cursor-model", "  gpt-5.5[reasoning=high] ");
    await expect(cursorModel).toHaveValue("gpt-5.5[reasoning=high]");

    // Clearing the field to retype it saves nothing, even after a pause; leaving it restores it.
    await cursorModel.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(800);
    await page.keyboard.press("Tab");
    await expect(cursorModel).toHaveValue("gpt-5.5[reasoning=high]");
    await expect(page.getByTestId("toast")).toHaveCount(0);

    await reloadApp(page);
    await openAgentSettings(page);
    await expect(cursor).toBeChecked();
    await expect(cursorModel).toHaveValue("gpt-5.5[reasoning=high]");

    // The choice is a radio group: arrow keys move it.
    await page.getByTestId("setting-harness-cursor").click();
    await expect(cursor).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(pi).toBeChecked();
    await expect(openRouterModel).toHaveValue("mock/scripted-agent");
    await retype(page, "setting-model", "vendor/model-a");

    await reloadApp(page);
    await openAgentSettings(page);
    await expect(pi).toBeChecked();
    await expect(openRouterModel).toHaveValue("vendor/model-a");
    await page.getByTestId("setting-harness-cursor").click();
    await expect(cursorModel).toHaveValue("gpt-5.5[reasoning=high]");
  });
});
