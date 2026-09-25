/**
 * The whole app against the fake model: the real daemon (live mode, Pi harness, safety gate,
 * approvals) serving the built UI, with OpenRouter replaced by the fake from `@ddl/agent/testing`.
 * Run with `pnpm --filter @ddl/web e2e:fullstack`.
 */
import { expect, type Page, test } from "@playwright/test";
import {
  badge,
  expandToolGroups,
  focusEditorEnd,
  sawStreaming,
  watchForStreaming,
} from "../helpers";

test.describe.configure({ mode: "serial" });

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("note-title")).toBeVisible();
  await page.waitForFunction(() =>
    window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
  );
}

/**
 * Types a task at the end of today's note with the real keyboard. The note always ends with an empty
 * task line (the template, or the one the previous task's Enter opened); pressing Enter afterwards
 * moves the cursor off the task so the watcher settles it quickly.
 */
async function addTask(page: Page, text: string): Promise<void> {
  await focusEditorEnd(page);
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press("Enter");
}

function badgeFor(page: Page, status: string) {
  return badge(page).and(page.locator(`.cm-ddl-badge-${status}`));
}

test("type a task → badge → streamed thread → approval → approve → done", async ({ page }) => {
  await openApp(page);
  await watchForStreaming(page);
  await addTask(page, "Order a replacement water filter");

  const toast = page.getByTestId("toast").filter({ hasText: "Approval needed" });
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(badgeFor(page, "waiting_approval")).toHaveCount(1);
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
  await expect(badgeFor(page, "done")).toHaveCount(1, { timeout: 20_000 });
  await expect(badgeFor(page, "done")).toHaveText(/Done · Ordered \(mock\)/);
  await expect(
    thread.getByTestId("message-text").filter({ hasText: "Done: order for" }),
  ).toBeVisible();
  expect(await sawStreaming(page)).toBe(true);
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
