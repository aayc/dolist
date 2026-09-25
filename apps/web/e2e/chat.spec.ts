import { expect, type Page, test } from "@playwright/test";
import { badge, expandToolGroups, expectDailyNote, openApp, typeTask } from "./helpers";

/**
 * The agent chat: typing reveal, live activity, tool rows, the chat bar, jump to latest, copy, and
 * reduced motion. The in-browser mock streams its replies word by word (`mockSpeed` divides its
 * delays), like the daemon's `thread.delta` events.
 */

declare global {
  interface Window {
    __chat?: {
      activity: string[];
      streaming: boolean;
      revealing: boolean;
      animations: string[];
      stopped?: boolean;
    };
  }
}

/** Animations that must not run with reduced motion. */
const MOTION = [
  "ddl-caret",
  "ddl-dot",
  "ddl-pulse",
  "ddl-enter",
  "ddl-activity-in",
  "ddl-ripple",
  "ddl-settle",
  "ddl-attention",
  "ddl-spin",
  "ddl-pop-in-small",
];

/** Records what the chat shows: activity labels, streaming/typing, animations in the agent panel. */
async function watchChat(page: Page): Promise<void> {
  await page.evaluate((motion) => {
    const seen: NonNullable<Window["__chat"]> = {
      activity: [],
      streaming: false,
      revealing: false,
      animations: [],
    };
    window.__chat = seen;
    const record = () => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-testid="chat-activity"]')) {
        const entry = `${el.dataset.kind}: ${el.querySelector(".chat-activity-label")?.textContent}`;
        if (!seen.activity.includes(entry)) seen.activity.push(entry);
      }
      if (document.querySelector('[data-streaming="true"]')) seen.streaming = true;
      if (document.querySelector('[data-revealing="true"]')) seen.revealing = true;
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-streaming", "data-revealing", "data-kind"],
    });
    const sample = () => {
      for (const animation of document.getAnimations()) {
        const name = animation instanceof CSSAnimation ? animation.animationName : "";
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (!target?.closest('[data-testid="right-panel"]')) continue;
        if (motion.includes(name) && !seen.animations.includes(name)) seen.animations.push(name);
      }
      if (!seen.stopped) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, MOTION);
}

async function watched(page: Page) {
  return page.evaluate(() => window.__chat!);
}

/** Types a task and opens its thread from the badge as soon as the badge shows. */
async function startTask(page: Page, text: string): Promise<void> {
  await typeTask(page, text);
  await expect(badge(page)).toHaveCount(1, { timeout: 15_000 });
  await badge(page).click();
  await expect(page.getByTestId("thread-view")).toBeVisible({ timeout: 10_000 });
}

function agentMessages(page: Page) {
  return page.locator('[data-testid="message-text"].is-agent');
}

async function isMac(page: Page): Promise<boolean> {
  return page.evaluate(() => /mac/i.test(navigator.platform));
}

async function hoverTooltip(page: Page, target: ReturnType<Page["locator"]>) {
  const box = await target.boundingBox();
  if (!box) throw new Error("target isn't visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  const tip = page.locator("#ddl-tooltip");
  await expect(tip).toHaveClass(/\bis-visible\b/);
  return tip;
}

/** A finished thread from the mock's demo note (yesterday): no agent to wait for. */
async function openFinishedThread(page: Page): Promise<void> {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expectDailyNote(page, -1);
  await page
    .locator(".cm-line", { hasText: "What's the tallest building in NYC?" })
    .locator(".cm-ddl-badge")
    .click();
  await expect(agentMessages(page).last()).toContainText("One World Trade Center");
}

test.describe("typing reveal", () => {
  test("a reply types out with a caret at the reveal point; history shows at once", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openApp(page, "mockSpeed=1");
    await watchChat(page);
    await startTask(page, "Research quiet mechanical keyboards");

    // Per frame: the length of each agent message and whether a caret shows.
    const frames = await page.evaluate(async () => {
      const out: Array<{ lengths: number[]; carets: number }> = [];
      const until = performance.now() + 2500;
      while (performance.now() < until) {
        await new Promise(requestAnimationFrame);
        const bodies = document.querySelectorAll(
          '[data-testid="message-text"].is-agent .message-body',
        );
        out.push({
          lengths: [...bodies].map((b) => b.textContent?.length ?? 0),
          carets: document.querySelectorAll(".type-caret").length,
        });
      }
      return out;
    });
    const intro = frames.map((f) => f.lengths[1] ?? 0);
    // It grows a few characters per frame: typed out, not dropped in whole. (It can shrink by the
    // markup a finished `**bold**` no longer shows.)
    const steps = intro.slice(1).map((length, i) => length - intro[i]!);
    expect(Math.max(...steps)).toBeLessThanOrEqual(15);
    expect(new Set(intro).size).toBeGreaterThan(15);
    expect(frames.some((f) => f.carets > 0)).toBe(true);

    await expect(badge(page)).toHaveClass(/cm-ddl-badge-done/, { timeout: 30_000 });
    await expect(agentMessages(page).last()).toContainText(
      "The full comparison is in the artifact",
    );
    await expect(page.locator(".type-caret")).toHaveCount(0);
    await expect(page.locator('[data-revealing="true"], [data-streaming="true"]')).toHaveCount(0);
    expect((await watched(page)).revealing).toBe(true);

    // Idle, the chat costs nothing: no animation frames requested, nothing animating in the panel.
    const idle = await page.evaluate(async () => {
      window.__chat!.stopped = true;
      await new Promise((resolve) => setTimeout(resolve, 400));
      const original = window.requestAnimationFrame;
      let frames = 0;
      window.requestAnimationFrame = (callback) => {
        frames++;
        return original(callback);
      };
      await new Promise((resolve) => setTimeout(resolve, 600));
      window.requestAnimationFrame = original;
      const panel = document.querySelector('[data-testid="right-panel"]');
      const running = document
        .getAnimations()
        .filter((a) => panel?.contains((a.effect as KeyframeEffect | null)?.target ?? null));
      return {
        frames,
        animations: running.map((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          const name = a instanceof CSSAnimation ? a.animationName : a.constructor.name;
          return `${name} on ${target?.className}`;
        }),
      };
    });
    expect(idle).toEqual({ frames: 0, animations: [] });

    // Reopened, it's history: all there on the first frame, nothing animates in.
    await page.getByTestId("thread-close").click();
    await badge(page).click();
    const reopened = await page.evaluate(async () => {
      while (!document.querySelector('[data-testid="chat-list"]')) {
        await new Promise(requestAnimationFrame);
      }
      const bodies = document.querySelectorAll(
        '[data-testid="message-text"].is-agent .message-body',
      );
      return {
        last: bodies[bodies.length - 1]?.textContent ?? "",
        carets: document.querySelectorAll(".type-caret").length,
        entering: document.querySelectorAll('[data-testid="chat-list"] .is-entering').length,
      };
    });
    expect(reopened.last).toContain("The full comparison is in the artifact.");
    expect(reopened.carets).toBe(0);
    expect(reopened.entering).toBe(0);
  });
});

test.describe("progress", () => {
  test("the activity row says what the agent is doing and leads to its approval", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openApp(page, "mockSpeed=2");
    await watchChat(page);
    await startTask(page, "Order a replacement water filter");
    await expect(page.locator(".thread-header .status-chip.is-pulsing")).toBeVisible();

    const activity = page.getByTestId("chat-activity");
    await expect(activity).toHaveAttribute("data-kind", "approval", { timeout: 20_000 });
    await expect(activity).toContainText("Waiting for your approval");
    const seen = await watched(page);
    expect(seen.activity).toContain("tool: Opening shop.example…");
    expect(seen.activity).toContain("tool: Working in the browser…");
    expect(seen.animations).toEqual(expect.arrayContaining(["ddl-enter", "ddl-ripple"]));
    await expect(page.getByTestId("composer-input")).toHaveAttribute(
      "placeholder",
      "Approve above, or reply to change course…",
    );
    await expect(page.getByTestId("chat-activity-elapsed")).toHaveText(/^· \d+s$/, {
      timeout: 6_000,
    });

    // Scrolled away, the row brings the card back and it asks for attention again.
    const scroller = page.getByTestId("chat-scroll");
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await activity.click();
    const card = page.getByTestId("approval-card");
    await expect(card).toHaveClass(/\bis-flashing\b/);
    await expect(card).toBeInViewport();

    await page.getByTestId("approve-once").click();
    await expect(badge(page)).toHaveClass(/cm-ddl-badge-done/, { timeout: 20_000 });
    await expect(activity).toHaveCount(0);
    await expect(page.locator(".thread-header .status-chip.is-pulsing")).toHaveCount(0);
  });

  test("tool calls spin, land on ✓, then fold into a group", async ({ page }) => {
    test.setTimeout(60_000);
    await openApp(page, "mockSpeed=1");
    await startTask(page, "Research quiet mechanical keyboards");

    await expect(
      page.locator('[data-testid="tool-call"][data-status="running"] .tool-call-status.spin'),
    ).toHaveCount(1, { timeout: 10_000 });
    // Seen running, it settles with a quick transition.
    await expect(
      page.locator(
        '[data-testid="tool-call"][data-tool="web_search"] .tool-call-status.is-settled',
      ),
    ).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("tool-group")).toBeVisible({ timeout: 15_000 });

    await expect(badge(page)).toHaveClass(/cm-ddl-badge-done/, { timeout: 30_000 });
    const group = page.getByTestId("tool-group");
    await expect(group).toHaveAttribute("data-count", "3");
    await expect(group).toContainText("Used 3 tools");
    await expect(page.getByTestId("tool-call")).toHaveCount(0);
    await expandToolGroups(page);
    await expect(group.getByTestId("tool-call")).toHaveCount(3);
    await expect(group.locator('[data-testid="tool-call"][data-status="ok"]')).toHaveCount(3);
  });
});

test.describe("the chat bar", () => {
  test("grows line by line up to eight, then scrolls; Enter sends and Shift+Enter adds a line", async ({
    page,
  }) => {
    await openFinishedThread(page);
    const input = page.getByTestId("composer-input");
    const send = page.getByTestId("composer-send");
    await expect(input).toHaveAttribute("placeholder", "Ask a follow-up…");
    await expect(send).toBeDisabled();

    const height = () => input.evaluate((el) => Math.round(el.getBoundingClientRect().height));
    await input.click();
    const heights = [await height()];
    await page.keyboard.type("line 1");
    await expect(send).toBeEnabled();
    for (let line = 2; line <= 10; line++) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(`line ${line}`);
      await expect.poll(height).toBe(Math.min(line, 8) * 20 + 10);
      heights.push(await height());
    }
    expect(heights).toEqual([30, 50, 70, 90, 110, 130, 150, 170, 170, 170]);
    expect(await input.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    // The Send tooltip shows Enter as a keycap from the key table.
    const tip = await hoverTooltip(page, send);
    await expect(tip.locator(".tooltip-text")).toHaveText("Send");
    expect(await tip.locator("kbd").allTextContents()).toEqual(
      (await isMac(page)) ? ["↩"] : ["Enter"],
    );

    await input.focus();
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect.poll(height).toBe(30);
    await expect(
      page.getByTestId("message-text").filter({ hasText: "line 10" }).last(),
    ).toBeVisible();
  });

  test("a reply shows at once while it sends; a failed one offers a retry", async ({ page }) => {
    await openFinishedThread(page);
    const input = page.getByTestId("composer-input");
    const pending = page.getByTestId("message-pending");

    await page.evaluate(() => window.__ddlDebug!.holdReplies({ ms: 1500 }));
    await input.click();
    await page.keyboard.type("Somewhere quiet, please");
    await page.keyboard.press("Enter");
    await expect(pending).toHaveAttribute("data-state", "sending");
    await expect(pending).toContainText("Somewhere quiet, please");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(
      page.getByTestId("message-text").filter({ hasText: "Somewhere quiet, please" }),
    ).toBeVisible();
    await expect(pending).toHaveCount(0);

    await page.evaluate(() => window.__ddlDebug!.holdReplies({ fail: 1 }));
    await page.keyboard.type("Try this one again");
    await page.keyboard.press("Enter");
    await expect(pending).toHaveAttribute("data-state", "failed");
    await expect(pending).toContainText("Couldn't send");
    await expect(page.getByTestId("toast")).toHaveCount(0);
    await pending.getByTestId("message-retry").click();
    await expect(
      page.getByTestId("message-text").filter({ hasText: "Try this one again" }),
    ).toBeVisible();
    await expect(pending).toHaveCount(0);
  });

  test("Stop stops the agent, from the chat bar or with its shortcut", async ({ page }) => {
    test.setTimeout(60_000);
    await openApp(page, "mockSpeed=1");
    await startTask(page, "Research quiet mechanical keyboards");
    const input = page.getByTestId("composer-input");
    await expect(input).toHaveAttribute("placeholder", "Reply to the agent…");

    const stop = page.getByTestId("composer-stop");
    await expect(stop).toBeVisible({ timeout: 10_000 });
    const tip = await hoverTooltip(page, stop);
    await expect(tip.locator(".tooltip-text")).toHaveText("Stop");
    const keys = await page.evaluate(() => window.__ddlDebug!.shortcutKeys("agent:stop"));
    expect(keys).toEqual((await isMac(page)) ? ["⌘", "."] : ["Ctrl", "."]);
    expect(await tip.locator("kbd").allTextContents()).toEqual(keys);
    await expect(stop).toHaveAttribute("aria-keyshortcuts", /^(Meta|Control)\+\.$/);

    await stop.click();
    const chip = page.locator(".thread-header [data-testid='status-chip']");
    await expect(chip).toHaveAttribute("data-status", "cancelled");
    await expect(stop).toHaveCount(0);
    await expect(input).toHaveAttribute("placeholder", "Ask a follow-up…");

    // The shortcut works from the editor too.
    await page.getByTestId("thread-retry").click();
    await expect(chip).toHaveAttribute("data-status", "working", { timeout: 10_000 });
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+Period");
    await expect(chip).toHaveAttribute("data-status", "cancelled");
  });
});

test.describe("jump to latest", () => {
  test.use({ viewport: { width: 1400, height: 460 } });

  test("scrolled up, new messages don't move you; the pill counts them and glides down", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openApp(page, "mockSpeed=1");
    await startTask(page, "Research quiet mechanical keyboards");
    const scroller = page.getByTestId("chat-scroll");
    const jump = page.getByTestId("jump-latest");
    await expect(jump).not.toHaveClass(/\bis-visible\b/);
    // Scroll up as soon as there's room to, while the agent is still writing.
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight), {
        timeout: 15_000,
        intervals: [50],
      })
      .toBeGreaterThan(60);

    await scroller.hover();
    await page.mouse.wheel(0, -2000);
    await expect(jump).toHaveClass(/\bis-visible\b/);
    const top = await scroller.evaluate((el) => el.scrollTop);
    await expect(jump).toContainText(/\d+ new/, { timeout: 20_000 });
    expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - top)).toBeLessThan(2);

    await jump.click();
    await expect
      .poll(() => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(48);
    await expect(jump).not.toHaveClass(/\bis-visible\b/);
  });
});

test.describe("copy", () => {
  test("a message copies its markdown, a code block its code", async ({ page, context }) => {
    test.setTimeout(60_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openApp(page, "mockSpeed=4");
    await startTask(page, "Organize the screenshots in my Downloads folder");
    await expect(badge(page)).toHaveClass(/cm-ddl-badge-done/, { timeout: 30_000 });
    const last = agentMessages(page).last();
    await expect(last.locator(".code-copy")).toHaveCount(1);

    await last.hover();
    await last.getByTestId("message-copy").click();
    await expect(last.getByTestId("message-copy")).toHaveAttribute("aria-label", "Copied");
    const message = await page.evaluate(() => navigator.clipboard.readText());
    expect(message).toContain("Finished **");
    expect(message).toContain("```sh");

    await last.locator(".code-wrap").hover();
    await last.locator(".code-copy").click();
    await expect(last.locator(".code-copy")).toHaveAttribute("aria-label", "Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "mv ~/Downloads/Screenshots/* ~/Downloads/\n",
    );
  });
});

test.describe("reduced motion", () => {
  test("text appears as it arrives and the indicators hold still", async ({ page }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openApp(page, "mockSpeed=1");
    await watchChat(page);
    await startTask(page, "Order a replacement water filter");
    await expect(page.getByTestId("chat-activity")).toHaveAttribute("data-kind", "approval", {
      timeout: 20_000,
    });
    await expect(page.locator(".thread-header .status-chip")).toBeVisible();

    const seen = await watched(page);
    expect(seen.streaming).toBe(true);
    expect(seen.revealing).toBe(false);
    expect(seen.animations).toEqual([]);
  });
});
