import { expect, test } from "@playwright/test";
import { badge, openApp, sawStreaming, typeTask, watchForStreaming } from "./helpers";

test.describe("the orchestrator's chat", () => {
  test("pinned in the inbox; shows each decision linked to its task; answers when written to", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openApp(page, "mockSpeed=4");
    await typeTask(page, "Research beginner guitar lessons");
    await expect(badge(page)).toHaveClass(/cm-ddl-badge-done/, { timeout: 25_000 });

    await page.keyboard.press("ControlOrMeta+Shift+A");
    const inbox = page.getByTestId("inbox");
    const pinned = inbox.getByTestId("inbox-orchestrator");
    await expect(pinned).toBeVisible();
    await expect(pinned).toContainText("Orchestrator");
    await expect(pinned.getByTestId("status-chip")).toHaveAttribute("data-status", "idle");
    // Pinned above the task threads, and not listed among them.
    await expect(inbox.locator(".inbox-scroll > *").first()).toHaveAttribute(
      "data-testid",
      "inbox-orchestrator",
    );
    await expect(inbox.getByTestId("inbox-item").filter({ hasText: "Orchestrator" })).toHaveCount(
      0,
    );
    await pinned.click();

    const view = page.getByTestId("orchestrator-view");
    await expect(view).toBeVisible();
    await expect(view.getByTestId("thread-title")).toHaveText("Orchestrator");
    await expect(view.getByTestId("status-divider").first()).toContainText("changed: 1 task");
    await expect(
      view.locator('[data-testid="tool-call"][data-tool="spawn_subagent"]'),
    ).toBeVisible();
    const link = view.getByTestId("orchestrator-task-link").first();
    await expect(link).toHaveText("Research beginner guitar lessons");

    await watchForStreaming(page);
    await view.getByTestId("composer-input").click();
    await page.keyboard.type("What are you working on?", { delay: 5 });
    await page.keyboard.press("Enter");
    await expect(
      view.getByTestId("message-text").filter({ hasText: "What are you working on?" }),
    ).toBeVisible();
    await expect(
      view.getByTestId("status-divider").filter({ hasText: "You wrote to me" }),
    ).toBeVisible();
    await expect(
      view.getByTestId("message-text").filter({ hasText: "Nothing is running right now." }),
    ).toContainText("Done today: 1.");
    expect(await sawStreaming(page)).toBe(true);

    // A decision's task link opens that task's thread.
    await link.click();
    await expect(page.getByTestId("thread-view")).toBeVisible();
    await expect(page.getByTestId("thread-title")).toHaveText("Research beginner guitar lessons");
  });

  test("the palette opens it, and Stop ends the run in progress", async ({ page }) => {
    await openApp(page, "mockSpeed=1");
    await page.keyboard.press("ControlOrMeta+P");
    await page.getByTestId("palette-input").fill("orchestrator");
    const item = page.getByTestId("palette-item").first();
    await expect(item).toContainText("Open the orchestrator's chat");
    await page.keyboard.press("Enter");

    const view = page.getByTestId("orchestrator-view");
    await expect(view).toBeVisible();
    await expect(view.getByTestId("orchestrator-empty")).toBeVisible();
    await view.getByTestId("composer-input").click();
    await page.keyboard.type("Tell me a story", { delay: 5 });
    await page.keyboard.press("Enter");
    const stop = view.getByTestId("thread-stop");
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(view.getByTestId("status-divider").last()).toContainText("You stopped this run");
    await expect(view.getByTestId("status-chip")).toHaveAttribute("data-status", "idle");
    await expect(stop).toBeHidden();
  });
});
