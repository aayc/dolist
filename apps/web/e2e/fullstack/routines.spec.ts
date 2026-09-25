/**
 * Routines against the real daemon (live mode, Pi harness, the fake model): the Routines section,
 * New routine from a template (and the daemon's reason for a schedule it can't read), a routine's
 * own inbox of runs, Run now (and why it can't run twice at once, or with the agent paused), Pause,
 * a finished run's notification, and Repeat this. Real keyboard throughout.
 * Run with `pnpm --filter @ddl/web e2e:fullstack`.
 */
import { expect, type Page, test } from "@playwright/test";
import { badge, focusEditorEnd } from "../helpers";

test.describe.configure({ mode: "serial" });

const ROUTINE = "Weekly review";

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("note-title")).toBeVisible();
  await page.waitForFunction(() =>
    window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
  );
}

/** Replaces a field's text with the real keyboard. */
async function typeInto(page: Page, testId: string, text: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text, { delay: 5 });
}

async function openRoutine(page: Page, name: string): Promise<void> {
  await page.getByTestId("ribbon-routines").click();
  await page.getByTestId("routine-item").filter({ hasText: name }).click();
  await expect(page.getByTestId("routine-view").getByTestId("routine-title")).toHaveText(name);
}

test("New routine from a template, its own inbox, Run now and Pause", async ({ page }) => {
  test.setTimeout(120_000);
  await openApp(page);

  // Reachable from the main navigation; nothing there yet.
  await page.getByTestId("ribbon-routines").click();
  const section = page.getByTestId("routines-view");
  await expect(section.getByTestId("routines-empty")).toBeVisible();

  // From a template; the daemon explains a schedule it won't take, under the schedule.
  await section.getByTestId("routines-empty-new").click();
  const dialog = page.getByTestId("new-routine-dialog");
  await dialog.getByTestId("routine-template").filter({ hasText: ROUTINE }).click();
  await expect(dialog.getByTestId("routine-name-input")).toHaveValue(ROUTINE);
  await expect(dialog.getByTestId("routine-schedule-preview")).toHaveText(
    "Every Sunday at 6:00 PM",
  );
  await typeInto(page, "routine-schedule-input", "every 5 minutes");
  await dialog.getByTestId("routine-create").click();
  await expect(dialog.getByTestId("routine-schedule-problem")).toHaveText(
    "Routines run at most every 15 minutes.",
  );
  await expect(dialog.getByTestId("routine-schedule-input")).toBeFocused();
  await typeInto(page, "routine-schedule-input", "every day at 9");
  await expect(dialog.getByTestId("routine-schedule-problem")).toBeHidden();
  await expect(dialog.getByTestId("routine-schedule-preview")).toHaveText("Every day at 9:00 AM");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();

  // Its own inbox: what it does and when, and no runs yet.
  const view = page.getByTestId("routine-view");
  await expect(view.getByTestId("routine-title")).toHaveText(ROUTINE);
  await expect(view.getByTestId("routine-view-schedule")).toHaveText("Every day at 9:00 AM");
  await expect(view.getByTestId("routine-view-next")).toContainText("at 9:00 AM");
  await expect(view.getByTestId("routine-view-notify")).toHaveText("After every run");
  await expect(view.getByTestId("routine-runs-empty")).toBeVisible();

  // Edit opens its file, a note in Routines/.
  await view.getByTestId("routine-edit").click();
  await expect(
    page.locator(`[data-testid="tab"][data-path="Routines/${ROUTINE}.md"]`),
  ).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("every day at 9");

  // Run now: the run is listed at once; a second one can't start while it goes.
  await view.getByTestId("routine-run").click();
  const runs = view.getByTestId("routine-run-item");
  await expect(runs).toHaveCount(1);
  await view.getByTestId("routine-run").click();
  const problem = view.getByTestId("routine-run-problem");
  await expect(problem).toContainText("It can't run right now");
  await expect(problem).toContainText(`“${ROUTINE}” is running right now.`);
  await expect(runs).toHaveCount(1);

  // Pause, then resume.
  await view.getByTestId("routine-pause").click();
  await expect(view.getByTestId("routine-view-paused")).toBeVisible();
  await expect(view.getByTestId("routine-pause")).toHaveText("Resume");
  await expect(view.getByTestId("routine-view-next")).toHaveText(
    "Paused: it won't run until you resume it.",
  );
  await expect(page.locator(".cm-content")).toContainText("paused: true");
  await view.getByTestId("routine-back").click();
  const row = section.getByTestId("routine-item").filter({ hasText: ROUTINE });
  await expect(row.getByTestId("routine-paused")).toBeVisible();
  await expect(row.getByTestId("routine-schedule")).toHaveText("Every day at 9:00 AM");
  await expect(row.getByTestId("routine-next")).toHaveCount(0);
  await row.click();
  await view.getByTestId("routine-pause").click();
  await expect(view.getByTestId("routine-view-paused")).toBeHidden();
  await expect(view.getByTestId("routine-view-next")).toContainText("at 9:00 AM");

  // The run finishes; the reason Run now gave is gone, and the run opens as a chat thread.
  await expect(runs.first()).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  await expect(problem).toBeHidden();
  await runs.first().click();
  const thread = page.getByTestId("thread-view");
  await expect(thread.getByTestId("thread-title")).toHaveText(ROUTINE);
  await expect(thread.getByTestId("status-chip").first()).toHaveAttribute("data-status", "done");
  await expect(thread.getByTestId("message-text").last()).toBeVisible();
  await expect(thread.getByTestId("thread-retry")).toHaveCount(0);
  await thread.getByTestId("thread-back").click();
  await expect(view).toBeVisible();

  // The list shows the last run; the main inbox doesn't list runs.
  await view.getByTestId("routine-back").click();
  await expect(
    row.locator('[data-testid="routine-last"] [data-testid="status-chip"]'),
  ).toHaveAttribute("data-status", "done");
  await page.keyboard.press("ControlOrMeta+Shift+A");
  await expect(page.getByTestId("inbox-routines")).toContainText(`Next: ${ROUTINE}`);
  await expect(page.getByTestId("inbox-item").filter({ hasText: ROUTINE })).toHaveCount(0);
});

test("a finished run notifies, and the notification opens the run", async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  await openRoutine(page, ROUTINE);
  const view = page.getByTestId("routine-view");
  const before = await view.getByTestId("routine-run-item").count();
  await view.getByTestId("routine-run").click();
  await expect(view.getByTestId("routine-run-item")).toHaveCount(before + 1);
  const threadId = await view
    .getByTestId("routine-run-item")
    .first()
    .getAttribute("data-thread-id");

  // The routine's inbox shows the run live; the toast comes while something else is on screen.
  await view.getByTestId("routine-back").click();
  const toast = page.getByTestId("toast").filter({ hasText: ROUTINE });
  await expect(toast).toBeVisible({ timeout: 60_000 });
  await expect(toast).toHaveAttribute("data-kind", "success");
  await toast.getByTestId("toast-body").click();
  const thread = page.getByTestId("thread-view");
  await expect(thread).toHaveAttribute("data-thread-id", threadId!);
  await expect(thread.getByTestId("thread-title")).toHaveText(ROUTINE);
});

test("Run now says why when the agent can't run", async ({ page }) => {
  await openApp(page);
  const agent = page.getByTestId("status-agent");
  await agent.click();
  await expect(agent).toHaveAttribute("data-state", "paused");
  try {
    await openRoutine(page, ROUTINE);
    const view = page.getByTestId("routine-view");
    await view.getByTestId("routine-run").click();
    const problem = view.getByTestId("routine-run-problem");
    await expect(problem).toContainText("The agent can't run here");
    await expect(problem).toContainText("switch it on to run routines");
    await problem.getByTestId("routine-run-problem-dismiss").click();
    await expect(problem).toBeHidden();
  } finally {
    await agent.click();
    await expect(agent).toHaveAttribute("data-state", "on");
  }
});

test("Repeat this: a finished task becomes a routine once you give it a schedule", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openApp(page);
  await focusEditorEnd(page);
  await page.keyboard.type("What's the tallest building in NYC?", { delay: 5 });
  await page.keyboard.press("Enter");
  const done = badge(page).and(page.locator(".cm-ddl-badge-done"));
  await expect(done).toHaveCount(1, { timeout: 30_000 });
  await done.click();

  const thread = page.getByTestId("thread-view");
  await thread.getByTestId("thread-repeat").click();
  const dialog = page.getByTestId("new-routine-dialog");
  await expect(dialog).toHaveAttribute("aria-label", "Repeat this task");
  await expect(dialog.getByTestId("routine-templates")).toHaveCount(0);
  await expect(dialog.getByTestId("routine-name-input")).toHaveValue(
    "What's the tallest building in NYC",
  );
  await expect(dialog.getByTestId("routine-instructions-input")).toHaveValue(
    "What's the tallest building in NYC?",
  );
  await expect(dialog.getByTestId("routine-create")).toBeDisabled();
  await expect(dialog.getByTestId("routine-schedule-input")).toBeFocused();
  await page.keyboard.type("every weekday at 7:30", { delay: 5 });
  await expect(dialog.getByTestId("routine-schedule-preview")).toHaveText(
    "Every weekday at 7:30 AM",
  );
  await dialog.getByTestId("routine-create").click();

  const view = page.getByTestId("routine-view");
  await expect(view.getByTestId("routine-title")).toHaveText("What's the tallest building in NYC");
  await expect(view.getByTestId("routine-view-schedule")).toHaveText("Every weekday at 7:30 AM");
  await expect(view.getByTestId("routine-instructions")).toHaveText(
    "What's the tallest building in NYC?",
  );
  await view.getByTestId("routine-back").click();
  await expect(page.getByTestId("routine-item")).toHaveCount(2);
});
