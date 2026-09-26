import { expect, test } from "./fixtures";
import { openApp } from "./helpers";

test.describe("computer use", () => {
  test("missing access shows in the status bar, and Settings walks through allowing it", async ({
    page,
  }) => {
    await openApp(page, "mockSpeed=4&mockComputer=missing");
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

    // The mock Mac turns a permission on a moment after its pane opens; polling picks it up.
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

    await openApp(page, "mockSpeed=4&mockComputer=none");
    await page.getByTestId("ribbon-settings").click();
    await page.getByTestId("settings-nav-computer").click();
    await expect(page.getByTestId("computer-unavailable")).toBeVisible();
    await expect(page.getByTestId("status-computer")).toHaveCount(0);
  });

  test("the command palette opens the section", async ({ page }) => {
    await openApp(page, "mockSpeed=4&mockComputer=missing");
    await page.keyboard.press("ControlOrMeta+P");
    await page.keyboard.type("computer use", { delay: 5 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("settings-computer")).toBeVisible();
  });
});
