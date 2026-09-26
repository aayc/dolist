import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
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
  test.use({ daemonSpec: { settings: { agent: { model: "vendor/model-e2e" } } } });

  test("the harness and each harness's model persist across reloads", async ({ page }) => {
    await openApp(page);
    await openAgentSettings(page);
    const pi = page.getByRole("radio", { name: "Pi · OpenRouter model" });
    const cursor = page.getByRole("radio", { name: "Cursor CLI · your Cursor account" });
    const openRouterModel = page.getByTestId("setting-model");
    const cursorModel = page.getByTestId("setting-cursor-model");
    await expect(pi).toBeChecked();
    await expect(openRouterModel).toHaveValue("vendor/model-e2e");
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
    await expect(openRouterModel).toHaveValue("vendor/model-e2e");
    await retype(page, "setting-model", "vendor/model-a");

    await reloadApp(page);
    await openAgentSettings(page);
    await expect(pi).toBeChecked();
    await expect(openRouterModel).toHaveValue("vendor/model-a");
    await page.getByTestId("setting-harness-cursor").click();
    await expect(cursorModel).toHaveValue("gpt-5.5[reasoning=high]");
  });
});

test.describe("approval policy", () => {
  test("each policy can be picked, Run everything asks first, and the status bar shows it", async ({
    page,
  }) => {
    await openApp(page);
    const indicator = page.getByTestId("status-approval-policy");
    await expect(indicator).toHaveCount(0);
    await openAgentSettings(page);

    const every = page.getByRole("radio", { name: "Ask before every action" });
    const risky = page.getByRole("radio", { name: "Ask for risky actions (recommended)" });
    const highRisk = page.getByRole("radio", { name: "Ask only for high-risk actions" });
    const everything = page.getByRole("radio", { name: "Run everything" });
    const dialog = page.getByTestId("confirm-dialog");
    await expect(page.getByRole("group", { name: "Approvals" })).toBeVisible();
    await expect(risky).toBeChecked();
    await expect(everything).toHaveAccessibleDescription(/Agents never ask/);

    // Stricter: saved at once, and named in the status bar.
    await page.getByTestId("setting-approval-ask_every_action").click();
    await expect(every).toBeChecked();
    await expect(indicator).toHaveText("Asks before every action");
    await expect(indicator).toHaveAttribute("data-tone", "neutral");

    // It's a radio group: the arrow keys move through the policies.
    await expect(every).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(risky).toBeChecked();
    await expect(indicator).toHaveCount(0);
    await page.keyboard.press("ArrowDown");
    await expect(highRisk).toBeChecked();
    await expect(indicator).toHaveText("Asks only for high-risk");

    // Run everything asks first; Escape keeps the current policy and the settings open.
    await page.keyboard.press("ArrowDown");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading")).toHaveText("Run everything without asking?");
    await expect(dialog).toContainText("Agents will act without asking you first");
    await expect(dialog).toContainText("reading passwords or keychains");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(highRisk).toBeChecked();
    await expect(everything).not.toBeChecked();

    // Cancel with the mouse keeps it too.
    await page.getByTestId("setting-approval-run_everything").click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(highRisk).toBeChecked();
    await expect(indicator).toHaveText("Asks only for high-risk");

    // Confirming (Return on the focused "Run everything" button) switches.
    await page.getByTestId("setting-approval-run_everything").click();
    await expect(dialog.getByRole("button", { name: "Run everything" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(everything).toBeChecked();
    await expect(indicator).toHaveText("Runs everything");
    await expect(indicator).toHaveAttribute("data-tone", "warning");
    await expect(indicator).toHaveAttribute("data-command", "settings:approvals");
    await expect(indicator).toHaveAttribute("data-tooltip", /run everything without asking/);

    // It persists, and the status bar item opens Settings → Agent.
    await reloadApp(page);
    await expect(indicator).toHaveText("Runs everything");
    await indicator.click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(page.getByTestId("settings-nav-agent")).toHaveAttribute("aria-current", "page");
    await expect(everything).toBeChecked();

    // Back to the default: no confirmation, and the status bar is quiet again.
    await page.getByTestId("setting-approval-ask_risky").click();
    await expect(dialog).toHaveCount(0);
    await expect(risky).toBeChecked();
    await expect(indicator).toHaveCount(0);
  });
});
