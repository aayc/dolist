import { expect, startDaemon, test } from "./fixtures";
import { openApp } from "./helpers";

/**
 * Computer use exists only on a Mac, with the Mac's own permissions: the daemon's test hooks
 * (DDL_TEST_HOOKS=1, apps/daemon/src/test-hooks.ts) simulate one, and opening a privacy pane allows
 * its permission a moment later instead of opening System Settings.
 */
const mac = (access: "missing" | "allowed") => ({
  daemonSpec: { env: { DDL_TEST_HOOKS: "1", DDL_TEST_COMPUTER: access } },
});

test.describe("computer use", () => {
  test.use(mac("missing"));

  test("missing access shows in the status bar, and Settings walks through allowing it", async ({
    page,
  }) => {
    await openApp(page);
    const warning = page.getByTestId("status-computer");
    await expect(warning).toBeVisible();
    await expect(warning).toHaveAttribute(
      "data-tooltip",
      "Agents can't use your Mac's apps yet: allow Accessibility and Screen Recording for “Daily Do List”",
    );
    await expect(warning).toHaveAttribute("data-command", "settings:computer");

    await warning.click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(page.getByTestId("settings-nav-computer")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("computer-host")).toContainText("Turn on “Daily Do List”");
    await expect(page.getByTestId("computer-status-accessibility")).toHaveText("Not allowed");
    await expect(page.getByTestId("computer-status-screenRecording")).toHaveText("Not allowed");
    await expect(page.getByTestId("computer-app-control")).toHaveText("On");
    await expect(page.getByTestId("computer-permission-screenRecording")).toContainText(
      "macOS asks to quit and reopen “Daily Do List”",
    );

    // The simulated Mac allows a permission a moment after its pane opens; polling picks it up.
    const openAccessibility = page.getByTestId("computer-open-accessibility");
    await expect(openAccessibility).toHaveAttribute(
      "data-tooltip",
      "Open System Settings → Privacy & Security → Accessibility",
    );
    await openAccessibility.click();
    await expect(page.getByTestId("computer-status-accessibility")).toHaveText("Allowed");
    await expect(openAccessibility).toHaveCount(0);
    await expect(warning).toHaveAttribute("data-tooltip", /allow Screen Recording for/);

    await page.getByTestId("computer-open-screenRecording").click();
    await expect(page.getByTestId("computer-status-screenRecording")).toHaveText("Allowed");
    await expect(page.getByTestId("computer-host")).toHaveCount(0);
    await expect(warning).toHaveCount(0);
  });

  test("the command palette opens the section", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+P");
    await page.keyboard.type("computer use", { delay: 5 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("settings-computer")).toBeVisible();
  });
});

test.describe("computer use allowed", () => {
  test.use(mac("allowed"));

  test("stays quiet when access is allowed, and explains a daemon without computer use", async ({
    page,
  }) => {
    await openApp(page);
    await expect(page.getByTestId("status-agent")).toHaveAttribute("data-state", "on");
    await expect(page.getByTestId("status-computer")).toHaveCount(0);
    await page.getByTestId("ribbon-settings").click();
    await page.getByTestId("settings-nav-computer").click();
    await expect(page.getByTestId("computer-status-accessibility")).toHaveText("Allowed");
    await expect(page.getByTestId("computer-open-accessibility")).toHaveCount(0);
    await expect(page.getByTestId("settings-computer")).toContainText("always off-limits");

    // A daemon without computer use (any machine but a Mac, or turned off).
    const plain = await startDaemon();
    try {
      await openApp(page, `${plain.url}/?debug=1`);
      await page.getByTestId("ribbon-settings").click();
      await page.getByTestId("settings-nav-computer").click();
      await expect(page.getByTestId("computer-unavailable")).toBeVisible();
      await expect(page.getByTestId("status-computer")).toHaveCount(0);
    } finally {
      await plain.close();
    }
  });
});
