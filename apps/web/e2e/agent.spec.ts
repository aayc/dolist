/**
 * The whole agent loop against the real daemon in live mode: the Pi harness, the safety gate and
 * approvals, with OpenRouter replaced by the fake from `@ddl/agent/testing` (streamed answers).
 */
import { expect, type Page, test } from "./fixtures";
import {
  badge,
  expandToolGroups,
  focusEditorEnd,
  openApp,
  sawStreaming,
  watchForStreaming,
} from "./helpers";

test.use({ daemonSpec: { agent: "live" } });

/**
 * Types a task at the end of today's note, then Enter: the cursor leaves the task, so the watcher
 * settles it quickly.
 */
async function addTask(page: Page, text: string): Promise<void> {
  await focusEditorEnd(page);
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press("Enter");
}

function badgeFor(page: Page, status: string) {
  return badge(page).and(page.locator(`.cm-ddl-badge-${status}`));
}

test.describe("agent threads", () => {
  test("type a task → badge → streamed thread → approval → approve → done", async ({ page }) => {
    await openApp(page);
    await watchForStreaming(page);
    await addTask(page, "Order a replacement water filter");
    await expect(badge(page)).toHaveCount(1, { timeout: 15_000 });

    // While the thread isn't open, the approval shows up as a toast that opens it.
    const toast = page.getByTestId("toast").filter({ hasText: "Approval needed" });
    await expect(toast).toBeVisible({ timeout: 30_000 });
    await expect(badgeFor(page, "waiting_approval")).toHaveCount(1);
    await expect(page.getByTestId("status-approvals")).toContainText("1 to approve");
    await expect(page.getByTestId("ribbon-inbox")).toHaveAccessibleName(/1 to approve/);
    await toast.getByTestId("toast-body").click();

    const thread = page.getByTestId("thread-view");
    await expect(page.getByTestId("thread-title")).toHaveText("Order a replacement water filter");
    await expect(
      thread
        .getByTestId("message-text")
        .filter({ hasText: "On it — order a replacement water filter." }),
    ).toBeVisible();
    await expect(
      thread.getByTestId("message-text").filter({ hasText: "gathering a few options first" }),
    ).toBeVisible();
    const card = page.getByTestId("approval-card");
    await expect(card).toHaveAttribute("data-status", "pending");
    await expandToolGroups(page);
    await expect(page.locator('[data-testid="tool-call"][data-tool="web_search"]')).toBeVisible();
    await expect(page.getByTestId("approval-summary")).toContainText("Mock order");

    await page.getByTestId("approve-once").click();
    await expect(card).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("approval-decided")).toContainText("Approved once by you");
    await expect(page.getByTestId("status-approvals")).toBeHidden();
    await expect(toast).toBeHidden();
    await expect(badgeFor(page, "done")).toHaveCount(1, { timeout: 20_000 });
    await expect(
      thread.getByTestId("message-text").filter({ hasText: "Done: order for" }),
    ).toBeVisible();
    expect(await sawStreaming(page)).toBe(true);

    // The badge opens the same thread again.
    await page.getByTestId("thread-close").click();
    await badge(page).click();
    await expect(page.getByTestId("thread-title")).toHaveText("Order a replacement water filter");
  });

  test("denying the approval blocks the action and the agent reports back", async ({ page }) => {
    await openApp(page);
    await addTask(page, "Book a table for two on Friday");
    const pending = badgeFor(page, "waiting_approval");
    await expect(pending).toHaveCount(1, { timeout: 30_000 });
    await pending.click();

    const card = page.getByTestId("approval-card");
    await expect(card).toHaveAttribute("data-status", "pending");
    await page.getByTestId("deny").click();
    await page.getByTestId("deny-note").fill("Friday is fully booked for me");
    await page.getByTestId("deny-confirm").click();

    await expect(card).toHaveAttribute("data-status", "denied");
    await expect(page.getByTestId("approval-decided")).toContainText("Denied by you");
    await expect(page.locator('[data-testid="tool-call"][data-status="blocked"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(badgeFor(page, "waiting_user")).toContainText("Needs your input", {
      timeout: 20_000,
    });
    await expect(
      page
        .getByTestId("message-text")
        .filter({ hasText: "wasn't approved (User denied: Friday is fully booked for me)" }),
    ).toBeVisible();
  });

  test("the artifact viewer shows what the agent wrote", async ({ page }) => {
    await openApp(page);
    await addTask(page, "Compare three robot vacuums");
    await expect(badgeFor(page, "done")).toHaveCount(1, { timeout: 30_000 });
    await badge(page).click();

    const card = page.getByTestId("artifact-card").first();
    await expect(card).toBeVisible();
    await card.click();
    const viewer = page.getByTestId("artifact-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.getByTestId("artifact-body")).toHaveAttribute("data-kind", "markdown");
    await expect(viewer.getByTestId("artifact-body")).toContainText("Compare three robot vacuums");
    await expect(viewer.getByTestId("artifact-download")).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();

    await expandToolGroups(page);
    await expect(page.locator('[data-testid="tool-call"][data-tool="web_search"]')).toBeVisible();
  });

  test("the inbox groups today's threads and opens them", async ({ page }) => {
    await openApp(page);
    await addTask(page, "Research beginner guitar lessons");
    await expect(badgeFor(page, "done")).toHaveCount(1, { timeout: 30_000 });
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
