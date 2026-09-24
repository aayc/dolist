import { expect, test } from "@playwright/test";
import { dailyHeading, noteTitle, openApp } from "../helpers";
import {
  caretToEnd,
  collectErrors,
  type EdgeWindow,
  expectSaved,
  explorerItem,
  listPaths,
  readNote,
  tab,
} from "./edge-helpers";

// Long, but under the 255-byte file name limit of common filesystems once encoded as UTF-8.
const LONG_NAME = "Ünïcödé 日本語のノート 😀👩‍💻 مرحبا עברית e\u0301 — plans for the whole quarter";
const RENAMED = "Заметка ✈️ 旅行の計画 — ٢٠٢٦ edition";

test.describe("long unicode note names", () => {
  test("create, type, find, rename and reopen a note with a long unicode name", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openApp(page);
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByTestId("switcher-input").fill(LONG_NAME);
    await page.keyboard.press("ControlOrMeta+Enter");
    const path = `${LONG_NAME}.md`;
    await expect(noteTitle(page)).toHaveValue(LONG_NAME);
    await expect(tab(page, path)).toHaveAttribute("data-tooltip", path);
    await expect(explorerItem(page, path)).toBeVisible();

    await caretToEnd(page);
    await page.keyboard.type("- [ ] 買い物 😀");
    await expect.poll(() => readNote(page, path)).toBe("- [ ] 買い物 😀");
    await expectSaved(page);

    // Find it again with a unicode query, from another note.
    await page.keyboard.press("ControlOrMeta+Shift+D");
    await page.keyboard.press("ControlOrMeta+O");
    await page.getByTestId("switcher-input").fill("日本語ノート");
    await expect(page.getByTestId("switcher-item").first()).toContainText("日本語のノート");
    await page.keyboard.press("Enter");
    await expect(noteTitle(page)).toHaveValue(LONG_NAME);

    const title = noteTitle(page);
    await title.fill(RENAMED);
    await title.press("Enter");
    await expect(explorerItem(page, `${RENAMED}.md`)).toBeVisible();
    await expect.poll(() => listPaths(page)).toContain(`${RENAMED}.md`);
    expect(await listPaths(page)).not.toContain(path);
    expect(await readNote(page, `${RENAMED}.md`)).toBe("- [ ] 買い物 😀");
    expect(errors).toEqual([]);
  });

  test("names with reserved characters are refused without touching the note", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => (window as unknown as EdgeWindow).__ddlDebug.openNote("Ideas.md"));
    const title = noteTitle(page);
    await expect(title).toHaveValue("Ideas");
    await title.fill("a/b: c?");
    await title.press("Enter");
    await expect(page.getByTestId("toast").filter({ hasText: "Can't rename" })).toBeVisible();
    await expect(title).toHaveValue("Ideas");
    expect(await listPaths(page)).toContain("Ideas.md");
  });
});

test.describe("theme", () => {
  test("toggling the theme while the app loads sticks, and survives a reload", async ({ page }) => {
    await page.goto("/?mock=1&mockSpeed=4");
    await page.waitForFunction(
      () => (window as unknown as Partial<EdgeWindow>).__ddlDebug !== undefined,
    );
    const initial = await page.evaluate(() => document.documentElement.dataset.theme);
    const target = initial === "dark" ? "light" : "dark";
    await page.evaluate(() =>
      (window as unknown as EdgeWindow).__ddlDebug.runCommand("theme:toggle"),
    );
    await page.waitForFunction(() =>
      window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", target);
    await expect(page.getByTestId("status-connection")).toHaveAttribute("data-state", "online");
    await page.waitForTimeout(300);
    await expect(page.locator("html")).toHaveAttribute("data-theme", target);

    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(target);
    await expect(dailyHeading(page)).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", target);
  });

  test("toggling twice quickly returns to the original theme", async ({ page }) => {
    await openApp(page);
    const initial = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.evaluate(() => {
      const debug = (window as unknown as EdgeWindow).__ddlDebug;
      debug.runCommand("theme:toggle");
      debug.runCommand("theme:toggle");
    });
    await page.waitForTimeout(200);
    await expect(page.locator("html")).toHaveAttribute("data-theme", initial!);
  });
});
