import { expect, type Page, test } from "@playwright/test";
import { badge, openApp } from "../helpers";
import { caretToEnd, collectErrors } from "./edge-helpers";

async function typeTasks(page: Page, tasks: string[]): Promise<void> {
  await caretToEnd(page);
  for (const [i, task] of tasks.entries()) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(task, { delay: 2 });
  }
}

const focusedTestId = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.closest("[data-testid]")?.getAttribute("data-testid") ?? null,
  );

test.describe("agent edge cases", () => {
  test("two tasks waiting for approval at once are decided independently", async ({ page }) => {
    test.setTimeout(60_000);
    const errors = collectErrors(page);
    await openApp(page, "mockSpeed=6");
    await typeTasks(page, ["Order a new desk lamp", "Book a haircut for Saturday"]);

    await expect(badge(page)).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator(".cm-ddl-badge-waiting_approval")).toHaveCount(2, {
      timeout: 25_000,
    });
    await expect(page.getByTestId("status-approvals")).toContainText("2 to approve");
    await expect(page.getByTestId("toast").filter({ hasText: "Approval needed" })).toHaveCount(2);

    await page.keyboard.press("ControlOrMeta+Shift+A");
    const needsYou = page.getByTestId("inbox-group-needs_you");
    await expect(needsYou.getByTestId("inbox-item")).toHaveCount(2);

    await needsYou.getByTestId("inbox-item").filter({ hasText: "desk lamp" }).click();
    await expect(page.getByTestId("thread-title")).toHaveText("Order a new desk lamp");
    await page.getByTestId("approve-once").click();
    await expect(page.getByTestId("approval-card")).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("status-approvals")).toContainText("1 to approve");

    await page.getByTestId("thread-back").click();
    await page.getByTestId("inbox-item").filter({ hasText: "haircut" }).click();
    await expect(page.getByTestId("thread-title")).toHaveText("Book a haircut for Saturday");
    await page.getByTestId("deny").click();
    await page.getByTestId("deny-note").fill("Not this week");
    await page.getByTestId("deny-confirm").click();
    await expect(page.getByTestId("approval-card")).toHaveAttribute("data-status", "denied");
    await expect(page.getByTestId("status-approvals")).toBeHidden();
    await expect(page.getByTestId("toast").filter({ hasText: "Approval needed" })).toHaveCount(0);

    await expect(page.locator(".cm-ddl-badge-done")).toHaveCount(2, { timeout: 25_000 });
    // Each badge stayed on its own task line.
    const lines = page.locator(".cm-line").filter({ has: page.locator(".cm-ddl-badge") });
    await expect(lines.filter({ hasText: "desk lamp" }).locator(".cm-ddl-badge")).toHaveCount(1);
    await expect(lines.filter({ hasText: "haircut" }).locator(".cm-ddl-badge")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("the thread panel works with the keyboard only", async ({ page }) => {
    test.setTimeout(60_000);
    await openApp(page, "mockSpeed=6");
    await typeTasks(page, ["Research quiet mechanical keyboards"]);
    await expect(page.locator(".cm-ddl-badge-done")).toHaveCount(1, { timeout: 25_000 });

    // Alt+Enter on the task line opens its thread.
    await page.keyboard.press("Alt+Enter");
    const thread = page.getByTestId("thread-view");
    await expect(thread).toBeVisible();

    // Escape then Tab leaves the editor (Tab alone indents); keep tabbing into the panel.
    await page.keyboard.press("Escape");
    const visited: string[] = [];
    for (let i = 0; i < 40 && !visited.includes("composer-input"); i++) {
      await page.keyboard.press("Tab");
      const id = await focusedTestId(page);
      if (
        id &&
        (await thread.locator(`[data-testid="${id}"]`).count()) > 0 &&
        !visited.includes(id)
      ) {
        visited.push(id);
      }
    }
    for (const id of [
      "thread-back",
      "thread-close",
      "thread-tab-chat",
      "thread-tab-artifacts",
      "composer-input",
    ]) {
      expect(visited, `reachable by Tab: ${id}`).toContain(id);
    }
    expect(visited.indexOf("thread-back")).toBeLessThan(visited.indexOf("composer-input"));

    // Send a reply with Enter; Shift+Enter adds a line instead.
    const composer = page.getByTestId("composer-input");
    await expect(composer).toBeFocused();
    await page.keyboard.type("Thanks!");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Second line");
    await expect(composer).toHaveValue("Thanks!\nSecond line");
    await page.keyboard.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(
      thread.getByTestId("message-text").filter({ hasText: "Second line" }),
    ).toBeVisible();

    // Shift+Tab back to the Artifacts tab and open it with Enter, then Chat with Space.
    for (let i = 0; i < 20 && (await focusedTestId(page)) !== "thread-tab-artifacts"; i++) {
      await page.keyboard.press("Shift+Tab");
    }
    await expect(page.getByTestId("thread-tab-artifacts")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("thread-tab-artifacts")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("artifact-list")).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("thread-tab-chat")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("thread-tab-chat")).toHaveAttribute("aria-selected", "true");
  });
});
