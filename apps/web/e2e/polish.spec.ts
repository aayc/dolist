import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { expectDailyNote, openApp, typeTask } from "./helpers";

/**
 * Tooltips, pointer cursors and the small details (see src/lib/tooltips.ts), with the real mouse.
 * Screenshots: DDL_POLISH_SHOTS=/some/dir pnpm --filter @ddl/web exec playwright test polish
 */

const OPEN_DELAY_MS = 500;

declare global {
  interface Window {
    __tipLog?: Array<{ t: number; text: string; className: string }>;
    __over?: Map<Element, number>;
  }
}

function tooltip(page: Page): Locator {
  return page.locator("#ddl-tooltip");
}

async function shownTooltip(page: Page, text: string): Promise<Locator> {
  const tip = tooltip(page);
  await expect(tip).toHaveClass(/\bis-visible\b/);
  await expect(tip.locator(".tooltip-text")).toHaveText(text);
  return tip;
}

async function keycaps(tip: Locator): Promise<string[]> {
  return tip.locator("kbd").allTextContents();
}

/** Moves the real mouse to the middle of `target`, in steps like a hand would. */
async function hover(page: Page, target: Locator, steps = 6): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error("target isn't visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
}

/** Records when the tooltip changes and when the pointer first enters each element. */
async function watchTooltip(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: NonNullable<Window["__tipLog"]> = [];
    window.__tipLog = log;
    window.__over = new Map();
    const record = () => {
      const tip = document.getElementById("ddl-tooltip");
      if (!tip) return;
      const entry = {
        t: performance.now(),
        text: tip.querySelector(".tooltip-text")?.textContent ?? "",
        className: tip.hidden ? "hidden" : tip.className,
      };
      const last = log.at(-1);
      if (last?.text !== entry.text || last?.className !== entry.className) log.push(entry);
    };
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "hidden"],
    });
    // On window, capturing: it runs before the tooltip layer's own listener on the document.
    window.addEventListener(
      "pointerover",
      (event) => {
        const target = (event.target as Element).closest("[data-tooltip]");
        if (target && !window.__over?.has(target)) window.__over?.set(target, performance.now());
      },
      true,
    );
  });
}

/** Milliseconds from the pointer entering `target` to its tooltip becoming visible. */
async function openDelay(target: Locator, text: string): Promise<number> {
  return target.evaluate((el, label) => {
    const over = window.__over?.get(el) ?? Number.NaN;
    const shown = window.__tipLog?.find(
      (e) => e.text === label && e.className.includes("is-visible") && e.t >= over,
    );
    return (shown?.t ?? Number.NaN) - over;
  }, text);
}

async function registryKeys(page: Page, id: string): Promise<readonly string[] | null> {
  return page.evaluate((command) => window.__ddlDebug!.shortcutKeys(command), id);
}

async function isMac(page: Page): Promise<boolean> {
  return page.evaluate(() => /mac/i.test(navigator.platform));
}

/** Yesterday's note in the mock vault is the living-list demo (badges, ✦, links, checkboxes). */
async function openDemoNote(page: Page): Promise<void> {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  await expectDailyNote(page, -1);
  await expect(page.locator(".cm-ddl-agent-sparkle").first()).toBeVisible();
}

test.describe("tooltips", () => {
  test("a header button's tooltip opens after the delay, with the registry's keycaps", async ({
    page,
  }) => {
    await openApp(page);
    await watchTooltip(page);
    const button = page.getByTestId("toggle-right-panel");
    await hover(page, button);
    const tip = await shownTooltip(page, "Toggle agent panel");
    expect(await openDelay(button, "Toggle agent panel")).toBeGreaterThanOrEqual(
      OPEN_DELAY_MS - 20,
    );
    const expected = (await isMac(page)) ? ["⌘", "\\"] : ["Ctrl", "\\"];
    expect(await registryKeys(page, "panel:right")).toEqual(expected);
    expect(await keycaps(tip)).toEqual(expected);
    await expect(button).toHaveAttribute("aria-keyshortcuts", /^(Meta|Control)\+\\$/);
    await expect(tip).toHaveAttribute("role", "tooltip");
    // In the top toolbar it sits below its button, inside the window.
    const [tipBox, buttonBox] = [await tip.boundingBox(), await button.boundingBox()];
    expect(tipBox!.y).toBeGreaterThanOrEqual(buttonBox!.y + buttonBox!.height + 4);
    expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(1400 - 8 + 1);
  });

  test("moving to the neighbor shows its tooltip at once, gliding over", async ({ page }) => {
    await openApp(page);
    await watchTooltip(page);
    const files = page.getByTestId("ribbon-files");
    const search = page.getByTestId("ribbon-search");
    await hover(page, files);
    await shownTooltip(page, "Toggle file explorer");
    await hover(page, search, 4);
    const tip = await shownTooltip(page, "Search vault");
    // Well under the open delay: no wait in warm mode.
    expect(await openDelay(search, "Search vault")).toBeLessThan(OPEN_DELAY_MS - 100);
    const glided = await page.evaluate(() =>
      window.__tipLog?.some((e) => e.text === "Search vault" && e.className.includes("is-gliding")),
    );
    expect(glided).toBe(true);
    expect(await keycaps(tip)).toEqual(await registryKeys(page, "search:open"));
    // Beside the left rail, it opens to the right.
    await expect(tip).toHaveAttribute("data-side", "right");
  });

  test("pressing the mouse hides the tooltip at once", async ({ page }) => {
    await openApp(page);
    const button = page.getByTestId("ribbon-daily");
    await hover(page, button);
    await shownTooltip(page, "Open today's note");
    await page.mouse.down();
    await expect(tooltip(page)).toBeHidden();
    await expect(tooltip(page)).toHaveClass("tooltip");
    await page.mouse.up();
    // Still over the button: it stays quiet.
    await page.waitForTimeout(OPEN_DELAY_MS + 200);
    await expect(tooltip(page)).toBeHidden();
  });

  test("typing hides it too", async ({ page }) => {
    await openApp(page);
    await hover(page, page.getByTestId("ribbon-settings"));
    await shownTooltip(page, "Open settings");
    await page.keyboard.press("Shift");
    await expect(tooltip(page)).toBeHidden();
  });

  test("the agent's ✦ and a badge in the editor show their tooltips", async ({ page }) => {
    await openDemoNote(page);
    const sparkle = page
      .locator(".cm-line", { hasText: "Trattoria Sole has a table" })
      .locator(".cm-ddl-agent-sparkle");
    await hover(page, sparkle);
    const tip = await shownTooltip(page, "Written by the agent — open thread");
    // Above everywhere but top toolbars.
    const [tipBox, sparkleBox] = [await tip.boundingBox(), await sparkle.boundingBox()];
    expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(sparkleBox!.y);

    await page.mouse.move(700, 850);
    await expect(tip).not.toHaveClass(/\bis-visible\b/);
    await page.waitForTimeout(400);
    const badge = page
      .locator(".cm-line", { hasText: "What's the tallest building in NYC?" })
      .locator(".cm-ddl-badge");
    const label = await badge.getAttribute("data-tooltip");
    expect(label).toContain("One World Trade Center");
    await hover(page, badge);
    await shownTooltip(page, label!);
  });

  test("a truncated tab shows its full path; a short one shows nothing", async ({ page }) => {
    await openApp(page);
    const path = "Projects/A note with a name far too long to fit in its tab.md";
    await page.evaluate((p) => window.__ddlMock!.createNote(p, "# Long"), path);
    await page.evaluate((p) => window.__ddlDebug!.openNote(p, true), path);
    const long = page.locator(`[data-testid="tab"][data-path="${path}"]`);
    await expect(long).toBeVisible();
    await hover(page, long.locator(".tab-title"));
    await shownTooltip(page, path);

    await page.mouse.move(700, 450);
    await page.waitForTimeout(400);
    const short = page.locator('[data-testid="tab"]').first();
    await expect(short).not.toHaveAttribute("data-path", path);
    await hover(page, short.locator(".tab-title"));
    await page.waitForTimeout(OPEN_DELAY_MS + 300);
    await expect(tooltip(page)).not.toHaveClass(/\bis-visible\b/);
  });

  test("a control that can't be used says why", async ({ page }) => {
    await openApp(page, "mockRemote=none");
    await page.keyboard.press("ControlOrMeta+Shift+A");
    await hover(page, page.getByTestId("placement-toggle-always_on_machine"));
    await shownTooltip(page, "This device doesn't sync");

    await openApp(page, "mockRemote=elsewhere");
    if ((await page.getByTestId("right-panel").count()) === 0) {
      await page.keyboard.press("ControlOrMeta+Shift+A");
    }
    await page.getByTestId("inbox-orchestrator").click();
    await hover(page, page.getByTestId("composer-send"));
    await shownTooltip(page, "The agent is running on Work laptop");
  });

  test("the command palette shows shortcuts as the same keycaps", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+P");
    const item = page.getByTestId("palette-item").filter({ hasText: "Toggle agent panel" });
    const expected = await registryKeys(page, "panel:right");
    expect(expected?.length).toBeGreaterThan(0);
    await expect(item.locator(".keycaps kbd")).toHaveText([...(expected ?? [])]);
    await expect(page.locator(".prompt-footer .keycaps").first()).toBeVisible();
  });
});

/*
 * The cursor audit: on each screen, every visible enabled control has the pointing hand, disabled
 * ones the arrow, editor text the I-beam; nothing else points; icon-only buttons have tooltips; and
 * no tooltip or name spells out a shortcut. It reads the DOM, so new controls are covered too.
 */
async function audit(
  page: Page,
  screen: string,
  { ignore = "", minControls = 5 }: { ignore?: string; minControls?: number } = {},
): Promise<void> {
  const problems = await page.evaluate(
    ([where, ignored, least]) => {
      const CONTROLS = [
        "button",
        "a[href]",
        "summary",
        "select",
        "label:has(> input:is([type=radio], [type=checkbox]))",
        ...["button", "tab", "menuitem", "option", "switch", "checkbox", "treeitem"].map(
          (role) => `[role=${role}]`,
        ),
        // Links the live preview renders: a plain click follows them.
        ".cm-ddl-link",
        ".cm-ddl-wikilink",
      ].join(", ");
      const SHORTCUT_TEXT = /[⌘⇧⌥⌃⎋↩⇥]|\b(?:Ctrl|Cmd|Alt|Shift|Meta)\+\S/;
      const shown = (el: Element) =>
        el.checkVisibility({ visibilityProperty: true }) &&
        el.getBoundingClientRect().width > 0 &&
        !el.closest("[aria-hidden=true]:not(.cm-gutters)") &&
        !(ignored && el.closest(ignored));
      const name = (el: Element) =>
        `<${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? ` ${el.getAttribute("data-testid")}` : ""} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}">`;
      const found: string[] = [];
      const controls = [...document.querySelectorAll(CONTROLS)].filter(shown);
      for (const el of controls) {
        const cursor = getComputedStyle(el).cursor;
        const disabled = el.matches(":disabled, [aria-disabled=true]");
        if (cursor !== (disabled ? "default" : "pointer")) {
          found.push(`${where}: ${name(el)} has cursor ${cursor}`);
        }
        // Buttons only: a switch is named by its setting, a tab or option by its text.
        const iconOnly =
          el.matches("button:not([role]), [role=button]") &&
          !/[\p{L}\p{N}]/u.test((el as HTMLElement).innerText ?? "");
        if (iconOnly && !disabled && !(el as HTMLElement).dataset.tooltip) {
          found.push(`${where}: icon-only ${name(el)} has no tooltip`);
        }
      }
      for (const el of document.querySelectorAll("body *")) {
        if (!shown(el) || getComputedStyle(el).cursor !== "pointer") continue;
        if (!el.closest(CONTROLS)) found.push(`${where}: ${name(el)} points but isn't a control`);
      }
      for (const el of document.querySelectorAll(".cm-content, .cm-line")) {
        const cursor = getComputedStyle(el).cursor;
        if (cursor !== "text") found.push(`${where}: editor text has cursor ${cursor}`);
      }
      for (const el of document.querySelectorAll("[data-tooltip], [aria-label]")) {
        const text = `${el.getAttribute("data-tooltip") ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
        if (SHORTCUT_TEXT.test(text)) found.push(`${where}: ${name(el)} spells out a shortcut`);
      }
      if (controls.length < least) found.push(`${where}: only ${controls.length} controls found`);
      return found;
    },
    [screen, ignore, minControls] as const,
  );
  expect(problems).toEqual([]);
}

test.describe("cursor audit", () => {
  test("workspace: ribbon, explorer, tabs, editor widgets, status bar", async ({ page }) => {
    await openDemoNote(page);
    await expect(page.locator(".cm-ddl-badge").first()).toBeVisible();
    await expect(page.locator(".cm-ddl-checkbox").first()).toBeVisible();
    await expect(page.locator(".cm-ddl-link").first()).toBeVisible();
    await audit(page, "workspace");
    await page.getByTestId("ribbon-search").click();
    await page.getByTestId("search-input").fill("Trattoria");
    await expect(page.getByTestId("search-hit").first()).toBeVisible();
    await audit(page, "search");
  });

  test("agent panel: a task waiting for approval, its inbox, toast and thread", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await openApp(page, "mockSpeed=4");
    await typeTask(page, "Order a replacement water filter");
    await expect(page.getByTestId("status-approvals")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("toast").first()).toBeVisible();
    await audit(page, "approval pending");
    await page.keyboard.press("ControlOrMeta+Shift+A");
    await expect(page.getByTestId("inbox-item").first()).toBeVisible();
    await audit(page, "inbox");
    await page.getByTestId("inbox-item").first().click();
    await expect(page.getByTestId("approval-card")).toHaveAttribute("data-status", "pending");
    await expect(page.getByTestId("tool-call").first()).toBeVisible();
    await audit(page, "thread");
    await page.getByTestId("tool-call").first().locator("button").click();
    await page.getByTestId("thread-tab-artifacts").click();
    await audit(page, "thread/artifacts");
  });

  test("a finished thread with citations and a wikilink", async ({ page }) => {
    await openDemoNote(page);
    await page
      .locator(".cm-line", { hasText: "What's the tallest" })
      .locator(".cm-ddl-badge")
      .click();
    await expect(page.getByTestId("message-text").last()).toContainText("One World Trade Center");
    await expect(page.locator("a[data-cite]").first()).toBeVisible();
    await audit(page, "thread/citations");
  });

  test("routines: the list, a routine's runs, a run, the New routine dialog", async ({ page }) => {
    test.setTimeout(60_000);
    // Full speed: a run lasts long enough to see Run now refused while it goes.
    await openApp(page, "mockSpeed=1");
    await page.evaluate(() => {
      window.__ddlMock!.createNote(
        "Routines/Morning briefing.md",
        "---\nschedule: every weekday at 7:30\n---\nBrief me for the day.\n",
      );
      window.__ddlMock!.createNote(
        "Routines/Price watch.md",
        "---\nschedule: every 2 hours\npaused: true\n---\nCheck the kettle's price.\n",
      );
      window.__ddlMock!.createNote("Routines/Broken.md", "---\nschedule: whenever\n---\nDo it.\n");
    });
    await page.keyboard.press("ControlOrMeta+Shift+A");
    await expect(page.getByTestId("inbox-routines")).toContainText("Next: Morning briefing");
    await page.getByTestId("ribbon-routines").click();
    await expect(page.getByTestId("routine-item")).toHaveCount(3);
    await audit(page, "routines");

    await page.getByTestId("routine-item").filter({ hasText: "Morning briefing" }).click();
    await page.getByTestId("routine-run").click();
    await page.getByTestId("routine-run").click();
    await expect(page.getByTestId("routine-run-problem")).toBeVisible();
    await expect(page.getByTestId("routine-run-item")).toHaveCount(1);
    await audit(page, "routine, run going");
    await expect(page.getByTestId("routine-run-item")).toHaveAttribute("data-status", "done", {
      timeout: 20_000,
    });
    await page.getByTestId("routine-run-item").click();
    await expect(page.getByTestId("thread-view")).toBeVisible();
    await expect(page.getByTestId("message-text").last()).toContainText("Nothing needs");
    await audit(page, "routine run");

    await page.getByTestId("thread-back").click();
    await page.getByTestId("routine-back").click();
    await page.getByTestId("routine-item").filter({ hasText: "Broken" }).click();
    await expect(page.getByTestId("routine-view-problem")).toBeVisible();
    await audit(page, "routine with a problem");

    await page.getByTestId("routine-back").click();
    await page.getByTestId("routines-new").click();
    await expect(page.getByTestId("routine-template").first()).toBeVisible();
    await audit(page, "new routine");
    await page.getByTestId("routine-template").first().click();
    await expect(page.getByTestId("routine-create")).toBeEnabled();
    await audit(page, "new routine, from a template");
  });

  test("settings, every section", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("ribbon-settings").click();
    for (const section of [
      "general",
      "editor",
      "daily",
      "agent",
      "location",
      "machine",
      "sync",
      "devices",
      "remote",
      "computer",
      "connectors",
      "about",
    ]) {
      await page.getByTestId(`settings-nav-${section}`).click();
      await audit(page, `settings/${section}`);
    }
  });

  test("drawings: selected, edited in place, and opened", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => window.__ddlDebug!.openNote("Sketches.md"));
    const drawing = page.locator(".cm-ddl-embed-drawing");
    await expect(drawing.locator("svg")).toBeVisible();
    await expect(page.getByTestId("insert-drawing")).toBeVisible();
    await audit(page, "drawing");
    await drawing.click();
    await expect(drawing).toHaveClass(/is-selected/);
    await expect(drawing.locator(".cm-ddl-embed-resize-start")).toBeVisible();
    await audit(page, "drawing selected");
    // The handles are drag affordances, not buttons: named by tooltips, never the pointing hand.
    const cursors = await drawing.evaluate((frame) =>
      [frame, ...frame.querySelectorAll(".cm-ddl-embed-grip, .cm-ddl-embed-resize")].map(
        (el) => `${el.className.split(" ")[0]}:${getComputedStyle(el).cursor}`,
      ),
    );
    expect(cursors).toEqual([
      "cm-ddl-embed:grab",
      "cm-ddl-embed-grip:grab",
      "cm-ddl-embed-resize:nesw-resize",
      "cm-ddl-embed-resize:nwse-resize",
    ]);

    // Excalidraw's own tool bar follows its conventions; the controls around it follow ours.
    await drawing.dblclick();
    const editor = page.getByTestId("drawing-editor");
    await expect(editor.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 20_000 });
    await audit(page, "drawing editor", { ignore: ".excalidraw" });
    await watchTooltip(page);
    await hover(page, page.getByTestId("drawing-done"));
    const tip = await shownTooltip(page, "Done");
    expect(await keycaps(tip)).toEqual((await isMac(page)) ? ["⎋"] : ["Esc"]);
    await page.getByTestId("drawing-done").click();
    await expect(editor).toBeHidden();

    await page.evaluate(() => window.__ddlDebug!.openNote("Excalidraw/Garden plan.excalidraw.md"));
    const pane = page.getByTestId("drawing-pane");
    await expect(pane.locator(".excalidraw canvas").first()).toBeVisible({ timeout: 20_000 });
    await audit(page, "opened drawing", { ignore: ".excalidraw" });
  });

  test("where the agent runs: the toggle, held here, read-only, and their settings", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // The panel stays open across reloads: open it only when it's closed.
    const panel = async (query: string) => {
      await openApp(page, query);
      if ((await page.getByTestId("right-panel").count()) === 0) {
        await page.keyboard.press("ControlOrMeta+Shift+A");
      }
      await expect(page.getByTestId("agent-location")).toBeVisible();
    };
    const settings = async (section: string) => {
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByTestId(`settings-nav-${section}`).click();
      await expect(page.getByTestId(`settings-${section}`)).toBeVisible();
    };

    await panel("mockRemote=none");
    await expect(page.getByTestId("placement-toggle")).toHaveAttribute("data-disabled", "true");
    await audit(page, "agent location, held here");
    await panel("mockSpeed=1&mockRemote=ready");
    await audit(page, "agent location");
    await page.getByTestId("placement-toggle-always_on_machine").click();
    await expect(page.getByTestId("agent-location-line")).toHaveAttribute("data-kind", "note");
    await audit(page, "agent location, handing over");
    await panel("mockRemote=host");
    await expect(page.getByTestId("placement-host")).toBeVisible();
    await audit(page, "agent location, the always-on machine");
    await panel("mockRemote=unreachable");
    await expect(page.getByTestId("agent-banner")).toBeVisible();
    await audit(page, "read-only, the machine can't be reached");
    await panel("mockRemote=elsewhere");
    await page.getByTestId("inbox-orchestrator").click();
    await expect(page.getByTestId("composer-input")).toBeDisabled();
    await audit(page, "read-only, another device runs the agent");

    await openApp(page, "mockRemote=unready");
    await settings("location");
    await expect(page.getByTestId("readiness-here")).toBeVisible();
    await audit(page, "settings/location, not ready");
    await page.keyboard.press("Escape");
    await openApp(page, "mockRemote=no_machine");
    await settings("machine");
    await page.getByTestId("machine-pair").click();
    await expect(page.getByTestId("machine-url-problem")).toBeVisible();
    await audit(page, "settings/machine, pairing");
    await openApp(page, "mockRemote=ready");
    await settings("machine");
    await expect(page.getByTestId("machine-status")).toBeVisible();
    await audit(page, "settings/machine, paired");
    await page.getByTestId("settings-nav-sync").click();
    await expect(page.getByTestId("sync-token-saved")).toBeVisible();
    await audit(page, "settings/sync, on");
    await openApp(page, "mockRemote=host");
    await settings("devices");
    await page.getByTestId("pairing-code-create").click();
    await expect(page.getByTestId("pairing-code-panel")).toBeVisible();
    await audit(page, "settings/devices, a code");
    await page.getByTestId("settings-nav-remote").click();
    await expect(page.getByTestId("remote-host")).toHaveCount(1);
    await audit(page, "settings/remote, a host");
    await openApp(page, "mockRemote=locked");
    await settings("remote");
    await expect(page.getByTestId("remote-locked")).toBeVisible();
    await audit(page, "settings/remote, locked");

    await page.goto("/?mock=1&mockAuth=pairing");
    await expect(page.getByTestId("pairing-screen")).toBeVisible();
    await audit(page, "pairing screen", { minControls: 1 });
  });

  test("palette and quick switcher", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+P");
    await expect(page.getByTestId("palette-item").first()).toBeVisible();
    await audit(page, "palette");
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+O");
    await expect(page.getByTestId("switcher-item").first()).toBeVisible();
    await audit(page, "switcher");
  });
});

test.describe("details", () => {
  /** Drags the real mouse across the text of `target` and returns what got selected. */
  async function dragAcross(page: Page, target: Locator): Promise<string> {
    const box = await target.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let text: Node | null = walker.nextNode();
      while (text && !text.textContent?.trim()) text = walker.nextNode();
      const range = document.createRange();
      range.selectNodeContents(text ?? el);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    });
    await page.mouse.move(box.x + 1, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    return page.evaluate(() => getSelection()?.toString() ?? "");
  }

  test("dragging over chrome selects nothing; notes and messages select", async ({ page }) => {
    await openDemoNote(page);
    expect(await dragAcross(page, page.getByTestId("status-words"))).toBe("");
    expect(await dragAcross(page, page.locator(".tab.is-active .tab-title"))).toBe("");
    expect(await dragAcross(page, page.locator(".panel-title").first())).toBe("");
    expect(
      await dragAcross(page, page.locator(".cm-line", { hasText: "Renew library" })),
    ).toContain("library");
    await page
      .locator(".cm-line", { hasText: "What's the tallest" })
      .locator(".cm-ddl-badge")
      .click();
    const answer = page.getByTestId("message-text").filter({ hasText: "1,776 ft" });
    expect(await dragAcross(page, answer.locator(".markdown p").first())).not.toBe("");
  });

  test("a theme switch changes colors without animating them", async ({ page }) => {
    await openApp(page);
    const transitions = await page.evaluate(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const before = document.documentElement.dataset.theme;
      window.__ddlDebug!.runCommand("theme:toggle");
      while (document.documentElement.dataset.theme === before) await frame();
      let most = 0;
      for (let i = 0; i < 6; i++) {
        const running = document.getAnimations().filter((a) => a instanceof CSSTransition);
        most = Math.max(most, running.length);
        await frame();
      }
      return most;
    });
    expect(transitions).toBe(0);
  });
});

test.describe("screenshots", () => {
  const dir = process.env.DDL_POLISH_SHOTS;
  test.skip(!dir, "set DDL_POLISH_SHOTS to a folder to take them");

  for (const theme of ["dark", "light"] as const) {
    test(`tooltips and keycaps, ${theme}`, async ({ page }) => {
      mkdirSync(dir!, { recursive: true });
      const shot = (name: string, clip: { x: number; y: number; width: number; height: number }) =>
        page.screenshot({ path: join(dir!, `${theme}-${name}.png`), clip });
      await openDemoNote(page);
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
        await page.evaluate(() => window.__ddlDebug!.runCommand("theme:toggle"));
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      }
      const settle = () => page.waitForTimeout(300);
      /** A 560×110 crop centered on an editor widget, with room for its tooltip above. */
      const around = (box: { x: number; y: number; width: number }) => ({
        x: Math.max(0, Math.min(box.x + box.width / 2 - 280, 1400 - 560)),
        y: box.y - 70,
        width: 560,
        height: 110,
      });

      await hover(page, page.getByTestId("toggle-right-panel"));
      await shownTooltip(page, "Toggle agent panel");
      await settle();
      await shot("header-tooltip", { x: 1100, y: 0, width: 300, height: 90 });

      await hover(page, page.getByTestId("ribbon-daily"));
      await shownTooltip(page, "Open today's note");
      await settle();
      await shot("ribbon-tooltip", { x: 0, y: 40, width: 340, height: 110 });

      await hover(page, page.getByTestId("status-agent"));
      await shownTooltip(page, "The agent is watching your daily notes — click to pause");
      await settle();
      await shot("status-tooltip", { x: 0, y: 800, width: 460, height: 100 });

      const sparkle = page
        .locator(".cm-line", { hasText: "Trattoria Sole has a table" })
        .locator(".cm-ddl-agent-sparkle");
      await hover(page, sparkle);
      await shownTooltip(page, "Written by the agent — open thread");
      await settle();
      await shot("sparkle-tooltip", around((await sparkle.boundingBox())!));

      const badge = page
        .locator(".cm-line", { hasText: "What's the tallest building in NYC?" })
        .locator(".cm-ddl-badge");
      await hover(page, badge);
      await shownTooltip(page, (await badge.getAttribute("data-tooltip"))!);
      await settle();
      await shot("badge-tooltip", around((await badge.boundingBox())!));

      await page.mouse.move(700, 880);
      await page.keyboard.press("ControlOrMeta+P");
      const palette = page.getByTestId("palette");
      await expect(palette).toBeVisible();
      await settle();
      await palette.screenshot({ path: join(dir!, `${theme}-palette.png`) });
    });
  }
});
