import { expect, test } from "@playwright/test";
import { badge, openApp, sawStreaming, typeTask, watchForStreaming } from "./helpers";

test.describe("agent threads", () => {
  test("new task → badge → thread with streamed messages → approval → done", async ({ page }) => {
    await openApp(page, "mockSpeed=2");
    await typeTask(page, "Order a replacement water filter");

    await expect(badge(page)).toHaveCount(1, { timeout: 15_000 });

    // While the thread isn't open, the approval shows up as a toast that opens it.
    const toast = page.getByTestId("toast").filter({ hasText: "Approval needed" });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(badge(page)).toHaveClass(/cm-ddl-badge-waiting_approval/);
    await expect(page.getByTestId("status-approvals")).toContainText("1 to approve");
    await expect(page.getByTestId("ribbon-inbox")).toHaveAccessibleName(/1 pending/);
    await toast.getByTestId("toast-body").click();

    const thread = page.getByTestId("thread-view");
    await expect(thread).toBeVisible();
    await expect(page.getByTestId("thread-title")).toHaveText("Order a replacement water filter");
    const card = page.getByTestId("approval-card");
    await expect(card).toHaveAttribute("data-status", "pending");
    await expect(page.getByTestId("approval-summary")).toContainText("Place order");
    await expect(
      thread.getByTestId("message-text").filter({ hasText: "find a good match" }),
    ).toBeVisible();

    await watchForStreaming(page);
    await page.getByTestId("approve-once").click();
    await expect(card).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("approval-decided")).toContainText("Approved once by you");
    await expect(page.getByTestId("status-approvals")).toBeHidden();
    await expect(toast).toBeHidden();

    await expect(badge(page)).toHaveClass(/cm-ddl-badge-done/, { timeout: 20_000 });
    await expect(badge(page)).toContainText("Done · Ordered");
    await expect(
      thread.getByTestId("message-text").filter({ hasText: "Order placed" }),
    ).toBeVisible();
    await expect(thread.getByTestId("status-chip").first()).toHaveAttribute("data-status", "done");
    expect(await sawStreaming(page)).toBe(true);

    // The badge opens the same thread again.
    await page.getByTestId("thread-close").click();
    await badge(page).click();
    await expect(page.getByTestId("thread-title")).toHaveText("Order a replacement water filter");
  });

  test("denying an approval blocks the action and finishes with a note", async ({ page }) => {
    await openApp(page, "mockSpeed=3");
    await typeTask(page, "Book a table for two on Friday");
    await expect(badge(page)).toHaveCount(1, { timeout: 15_000 });
    await badge(page).click();

    const card = page.getByTestId("approval-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("deny").click();
    await page.getByTestId("deny-note").fill("Friday is fully booked for me");
    await page.getByTestId("deny-confirm").click();

    await expect(card).toHaveAttribute("data-status", "denied");
    await expect(page.getByTestId("approval-decided")).toContainText("Denied by you");
    await expect(page.locator('[data-testid="tool-call"][data-status="blocked"]')).toBeVisible();
    await expect(badge(page)).toHaveClass(/cm-ddl-badge-done/, { timeout: 20_000 });
    await expect(badge(page)).toContainText("Not booked");
    await expect(
      page.getByTestId("message-text").filter({ hasText: "Friday is fully booked for me" }),
    ).toBeVisible();
  });

  test("artifact viewer and live browser frames", async ({ page }) => {
    await openApp(page, "mockSpeed=4");
    await typeTask(page, "Compare three robot vacuums");
    await expect(badge(page)).toHaveClass(/cm-ddl-badge-done/, { timeout: 25_000 });
    await expect(badge(page)).toContainText("Done · 3 options");
    await badge(page).click();

    const card = page.getByTestId("artifact-card").first();
    await expect(card).toBeVisible();
    await card.click();
    const viewer = page.getByTestId("artifact-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId("artifact-body")).toHaveAttribute("data-kind", "markdown");
    await expect(viewer.locator("table")).toContainText("all-rounder");
    await expect(viewer.getByTestId("artifact-download")).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();

    await page.getByTestId("thread-tab-browser").click();
    const frame = page.getByTestId("browser-frame");
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    await expect(page.getByTestId("browser-url")).toContainText("guide.example");

    await page.getByTestId("thread-tab-chat").click();
    await expect(page.locator('[data-testid="tool-call"][data-tool="web_search"]')).toBeVisible();
  });

  test("inbox groups today's threads and opens them", async ({ page }) => {
    await openApp(page, "mockSpeed=4");
    await typeTask(page, "Research beginner guitar lessons");
    await expect(badge(page)).toHaveClass(/cm-ddl-badge-done/, { timeout: 25_000 });
    await page.keyboard.press("ControlOrMeta+Shift+A");
    const inbox = page.getByTestId("inbox");
    await expect(inbox).toBeVisible();
    await expect(inbox.getByTestId("inbox-group-done")).toContainText(
      "Research beginner guitar lessons",
    );
    await inbox
      .getByTestId("inbox-item")
      .filter({ hasText: "Research beginner guitar lessons" })
      .click();
    await expect(page.getByTestId("thread-title")).toHaveText("Research beginner guitar lessons");
    await page.getByTestId("thread-back").click();
    await expect(inbox).toBeVisible();
  });
});
