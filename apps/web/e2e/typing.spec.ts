import { expect, test } from "@playwright/test";
import { dailyPath, focusEditorEnd, openApp, waitForSaved } from "./helpers";

test.describe("typing markdown with a real keyboard", () => {
  test("today's note opens with the caret after the template, ready for a task", async ({
    page,
  }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+Shift+D");
    await page.keyboard.type("Buy oat milk", { delay: 5 });
    await waitForSaved(page);
    const content = await page.evaluate((path) => window.__ddlMock!.readNote(path), dailyPath());
    expect(content).toBe("- [ ] Buy oat milk");
  });

  test("types task checkboxes, links and continues lists on Enter", async ({ page }) => {
    await openApp(page);
    await focusEditorEnd(page);
    await page.keyboard.type("Book dentist", { delay: 5 });
    await page.keyboard.press("Enter");
    await page.keyboard.type("Plan trip to [[Kyoto]] (see [guide](https://example.com))", {
      delay: 5,
    });
    // Like Obsidian: Enter on an empty task item ends the list instead of adding another item.
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- [ ] typed from scratch", { delay: 5 });
    await waitForSaved(page);

    const content = await page.evaluate((path) => window.__ddlMock!.readNote(path), dailyPath());
    expect(content).toBe(
      [
        "- [ ] Book dentist",
        "- [ ] Plan trip to [[Kyoto]] (see [guide](https://example.com))",
        "- [ ] typed from scratch",
      ].join("\n"),
    );
  });
});
