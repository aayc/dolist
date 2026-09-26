import { expect, type Page, test } from "./fixtures";
import { expectDailyNote, noteTitle, openApp, waitForSaved } from "./helpers";

/** Yesterday's note in the mock vault is the living-list demo (apps/web/src/api/mock/mock-demo.ts). */
async function openDemoNote(page: Page): Promise<void> {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expectDailyNote(page, -1);
}

function line(page: Page, text: string) {
  return page.locator(".cm-line").filter({ hasText: text });
}

function popover(page: Page) {
  return page.locator(".cm-ddl-link-popover");
}

/** The theme's value of a color token, as the browser computes colors ("rgb(…)" / "rgba(…)"). */
async function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = `var(${name})`;
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

test.describe("the agent writing in notes", () => {
  test("agent lines use the agent color, hide their marker and open their thread from ✦", async ({
    page,
  }) => {
    await openDemoNote(page);
    const written = line(page, "Trattoria Sole has a table for 2");
    await expect(written).toHaveClass(/cm-ddl-agent-line/);
    await expect(written).not.toContainText("%%agent");
    await expect(written).toHaveCSS("color", await tokenColor(page, "--ddl-agent-text"));
    // The user's own lines keep the text color; the agent's task keeps a normal checkbox.
    await expect(line(page, "Renew library books")).not.toHaveClass(/cm-ddl-agent-line/);
    const task = line(page, "Call the restaurant to confirm");
    await expect(task).toHaveClass(/cm-ddl-agent-line/);
    await expect(task.locator(".cm-ddl-checkbox")).toHaveAttribute("aria-checked", "false");

    // With the caret on the line (it starts at the end of the note), the marker shows, faint.
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
    await expect(written.locator(".cm-ddl-agent-marker")).toHaveText("%%agent:thr_demo_dinner%%");
    await expect(written.locator(".cm-ddl-agent-sparkle")).toHaveCount(0);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");

    const sparkle = written.locator(".cm-ddl-agent-sparkle");
    await expect(sparkle).toHaveText("✦");
    await expect(sparkle).toHaveAttribute("data-tooltip", "Written by the agent — open thread");
    await expect(sparkle).toHaveCSS("color", await tokenColor(page, "--ddl-accent"));
    await sparkle.click();
    await expect(page.getByTestId("thread-title")).toHaveText("Book a table for Friday dinner");
  });

  test("a question with an anchored thread is highlighted and its badge opens the thread", async ({
    page,
  }) => {
    await openDemoNote(page);
    const question = line(page, "What's the tallest building in NYC?");
    await expect(question).toHaveClass(/cm-ddl-anchored/);
    await expect(question).toHaveCSS("background-color", await tokenColor(page, "--ddl-anchor-bg"));
    const badge = question.locator(".cm-ddl-badge");
    await expect(badge).toContainText("Done · One World Trade Center");
    await badge.click();
    await expect(page.getByTestId("thread-title")).toHaveText(
      "What's the tallest building in NYC?",
    );
    await expect(page.getByTestId("message-text").last()).toContainText("One World Trade Center");
  });

  test("numbered citations are chips with a preview of the cited source", async ({ page }) => {
    await openDemoNote(page);
    await line(page, "What's the tallest building in NYC?").locator(".cm-ddl-badge").click();
    const answer = page.getByTestId("message-text").filter({ hasText: "1,776 ft" });
    const chips = answer.locator("a[data-cite]");
    await expect(chips).toHaveText(["1", "2"]);
    await expect(chips.first()).toHaveCSS("vertical-align", "super");
    await expect(answer.locator("strong")).toHaveText("One World Trade Center");

    await chips.first().hover();
    await expect(popover(page)).toBeVisible();
    await expect(popover(page).locator(".cm-ddl-link-preview-title")).toHaveText(
      "One World Trade Center — Skyscraper Index",
    );
    await expect(popover(page).locator(".cm-ddl-link-preview-host")).toHaveText(
      "skyscrapers.example",
    );
    await expect(popover(page).locator(".cm-ddl-link-preview-snippet")).toContainText("1,776 feet");
    await expect(popover(page).locator(".cm-ddl-link-preview-url")).toHaveText(
      "https://skyscrapers.example/one-world-trade-center",
    );
    await page.getByTestId("thread-title").hover();
    await expect(popover(page)).toHaveCount(0);
  });

  test("a wikilink cited in a thread previews the note and opens it", async ({ page }) => {
    await openDemoNote(page);
    await line(page, "Trattoria Sole has a table for 2").locator(".cm-ddl-agent-sparkle").click();
    const wikilink = page.locator("[data-testid='message-text'] a[data-wikilink]").first();
    await expect(wikilink).toHaveText("Restaurants");
    await wikilink.hover();
    await expect(popover(page).locator(".cm-ddl-link-preview-title")).toHaveText("Restaurants");
    await expect(popover(page).locator(".cm-ddl-link-preview-line").first()).toHaveText(
      "# Restaurants",
    );
    await wikilink.click();
    await expect(noteTitle(page)).toHaveValue("Restaurants");
  });

  test("hovering a wikilink in the editor previews the note", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__ddlDebug?.openNote("Welcome.md"));
    await expect(noteTitle(page)).toHaveValue("Welcome");
    await page.locator(".cm-ddl-wikilink", { hasText: "Ideas" }).hover();
    const card = popover(page);
    await expect(card).toBeVisible();
    await expect(card.locator(".cm-ddl-link-preview-title")).toHaveText("Ideas");
    await expect(card.locator(".cm-ddl-link-preview-line")).toHaveText([
      "# Ideas",
      "- A weekly review template that pulls unfinished tasks forward",
      "- Batch errands by neighborhood",
      "- Try a no-meeting Wednesday",
      "> Small steps every day.",
    ]);
    // Typing hides it.
    await page.keyboard.press("ArrowDown");
    await expect(card).toHaveCount(0);
  });

  test("a link on an agent line previews the source its thread cites", async ({ page }) => {
    await openDemoNote(page);
    await line(page, "Trattoria Sole has a table for 2").locator(".cm-ddl-link").hover();
    const card = popover(page);
    await expect(card.locator(".cm-ddl-link-preview-title")).toHaveText(
      "Trattoria Sole — Book a table",
    );
    await expect(card.locator(".cm-ddl-link-preview-host")).toHaveText("tables.example");
    await expect(card.locator(".cm-ddl-link-preview-snippet")).toContainText("7:00 PM");
  });
});

test.describe("agent edits meeting the user's typing", () => {
  const AGENT_LINE = "- A monthly someday review %%agent:thr_demo_dinner%%";

  async function agentAppends(page: Page): Promise<void> {
    await page.evaluate((added) => {
      const mock = window.__ddlMock!;
      mock.externalEdit("Ideas.md", `${mock.readNote("Ideas.md")}\n${added}`);
    }, AGENT_LINE);
  }

  async function typeInIdeas(page: Page): Promise<void> {
    await page.evaluate(() => window.__ddlDebug?.openNote("Ideas.md"));
    await expect(noteTitle(page)).toHaveValue("Ideas");
    await line(page, "Batch errands by neighborhood").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" on Saturday", { delay: 5 });
  }

  async function expectMerged(page: Page): Promise<void> {
    // The caret stayed where the user was typing.
    await page.keyboard.type(" mornings", { delay: 5 });
    await expect(line(page, "Batch errands")).toHaveText(
      "Batch errands by neighborhood on Saturday mornings",
    );
    await expect(line(page, "A monthly someday review")).toHaveClass(/cm-ddl-agent-line/);
    await waitForSaved(page);
    await expect
      .poll(() => page.evaluate(() => window.__ddlMock?.readNote("Ideas.md")))
      .toBe(
        [
          "# Ideas",
          "",
          "- A weekly review template that pulls unfinished tasks forward",
          "- Batch errands by neighborhood on Saturday mornings",
          "- Try a no-meeting Wednesday",
          "",
          "> Small steps every day.",
          AGENT_LINE,
        ].join("\n"),
      );
    expect(
      (await page.evaluate(() => window.__ddlMock!.listPaths())).filter((p) =>
        p.includes("(conflict"),
      ),
    ).toEqual([]);
    await expect(page.getByTestId("toast").filter({ hasText: "changed elsewhere" })).toHaveCount(0);
  }

  test("an agent edit arriving while the user types is merged, without a conflict copy", async ({
    page,
  }) => {
    await openApp(page);
    await typeInIdeas(page);
    await agentAppends(page);
    await expect(line(page, "A monthly someday review")).toBeVisible();
    await expectMerged(page);
  });

  test("a save that meets an agent edit is merged too", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__ddlDebug?.delayWrites(600));
    await typeInIdeas(page);
    await page.waitForTimeout(400); // the save of " on Saturday" is now in flight
    await agentAppends(page);
    await page.evaluate(() => window.__ddlDebug?.delayWrites(0));
    await expect(line(page, "A monthly someday review")).toBeVisible();
    await expectMerged(page);
  });
});
