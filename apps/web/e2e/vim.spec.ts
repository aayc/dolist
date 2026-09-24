import { expect, type Page, test } from "@playwright/test";
import { badge, dailyPath, noteTitle, openApp, typeTask, waitForSaved } from "./helpers";

// Every key goes through Playwright's real keyboard: vim reads keydown events, and fill-style
// typing would bypass it (see AGENTS.md).

const NAMED: Record<string, string> = {
  Esc: "Escape",
  CR: "Enter",
  BS: "Backspace",
  Tab: "Tab",
  Space: "Space",
};

/** Types vim notation: `gg`, `<Esc>`, `<C-v>` (literal Control), `:w<CR>`. */
async function vim(page: Page, keys: string): Promise<void> {
  for (const [token] of keys.matchAll(/<(?:C-)?[A-Za-z]+>|[\s\S]/g)) {
    const ctrl = /^<C-(.+)>$/.exec(token);
    if (ctrl) await page.keyboard.press(`Control+${ctrl[1]}`);
    else if (token.length > 1) await page.keyboard.press(NAMED[token.slice(1, -1)] ?? token);
    else await page.keyboard.type(token, { delay: 5 });
  }
}

function status(page: Page) {
  return page.getByTestId("status-vim");
}

async function expectMode(page: Page, mode: string): Promise<void> {
  await expect(status(page)).toHaveAttribute("data-mode", mode);
}

/** Turns vim on through the command palette's command and waits until it is running. */
async function enableVim(page: Page): Promise<void> {
  await page.evaluate(() => window.__ddlDebug!.runCommand("editor:vim"));
  await expectMode(page, "normal");
  await page.locator(".cm-content").click();
}

async function savedNote(page: Page, path = dailyPath()): Promise<string | null> {
  await waitForSaved(page);
  return page.evaluate((p) => window.__ddlMock!.readNote(p), path);
}

test.describe("vim mode", () => {
  test("toggles from settings and from the command palette", async ({ page }) => {
    await openApp(page);
    await expect(status(page)).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByTestId("settings-nav-editor").click();
    await expect(page.getByTestId("setting-vimrc")).toHaveCount(0);
    await page.getByTestId("setting-vim").click();
    await expect(page.getByTestId("setting-vim")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("setting-vimrc")).toBeVisible();
    await page.keyboard.press("Escape");
    await expectMode(page, "normal");

    await page.keyboard.press("ControlOrMeta+P");
    await page.getByTestId("palette-input").fill("Toggle vim");
    await page.keyboard.press("Enter");
    await expect(status(page)).toHaveCount(0);
    await expect(page.locator(".cm-vimMode")).toHaveCount(0);
  });

  test("insert a task, leave insert mode, dd, u, p — with list continuation on Enter", async ({
    page,
  }) => {
    await openApp(page);
    await enableVim(page);
    await vim(page, "ggA");
    await expectMode(page, "insert");
    await vim(page, "Buy oat milk<CR>Call the bank");
    await vim(page, "<Esc>");
    await expectMode(page, "normal");
    expect(await savedNote(page)).toBe("- [ ] Buy oat milk\n- [ ] Call the bank");

    await vim(page, "ggdd");
    expect(await savedNote(page)).toBe("- [ ] Call the bank");
    await vim(page, "u");
    expect(await savedNote(page)).toBe("- [ ] Buy oat milk\n- [ ] Call the bank");
    await vim(page, "Gp");
    expect(await savedNote(page)).toBe(
      "- [ ] Buy oat milk\n- [ ] Call the bank\n- [ ] Buy oat milk",
    );
  });

  test("visual yank and paste", async ({ page }) => {
    await openApp(page);
    await enableVim(page);
    await vim(page, "ggAsoy milk<Esc>");
    await vim(page, "0fsve");
    await expectMode(page, "visual");
    await vim(page, "y");
    await expectMode(page, "normal");
    await vim(page, "$p");
    expect(await savedNote(page)).toBe("- [ ] soy milksoy");
    await vim(page, "Vyp");
    expect(await savedNote(page)).toBe("- [ ] soy milksoy\n- [ ] soy milksoy");
  });

  test("works with the markdown editor: Enter and Tab, checkboxes, / search, wiki links", async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate(() => window.__ddlMock!.createNote("Garden.md", "# Garden"));
    await page.evaluate(() => window.__ddlDebug!.openNote("Garden.md"));
    await expect(noteTitle(page)).toHaveValue("Garden");
    await enableVim(page);

    // Insert mode keeps list continuation on Enter, list indentation on Tab and bracket pairing.
    await vim(page, "Go- [ ] Water the plants<CR><Tab>Buy soil for the [[Balcony]] pots<Esc>");
    await expectMode(page, "normal");
    const tasks = "- [ ] Water the plants\n\t- [ ] Buy soil for the [[Balcony]] pots";
    expect(await savedNote(page, "Garden.md")).toBe(`# Garden\n${tasks}`);

    // Live preview still renders the syntax the cursor isn't on.
    await vim(page, "gg");
    await expect(page.locator(".cm-ddl-wikilink")).toHaveText("Balcony");
    await page.locator(".cm-ddl-checkbox").first().click();
    expect(await savedNote(page, "Garden.md")).toContain("- [x] Water the plants");

    await vim(page, "/plants<CR>");
    await expect(page.locator(".cm-searchMatch")).toHaveCount(1);
    await vim(page, "ciwroses<Esc>");
    expect(await savedNote(page, "Garden.md")).toContain("- [x] Water the roses");
    await vim(page, ":noh<CR>");
    await expect(page.locator(".cm-searchMatch")).toHaveCount(0);

    await vim(page, "/balc<CR>");
    await page.keyboard.press("Alt+Enter");
    await expect(noteTitle(page)).toHaveValue("Balcony");
  });

  test("dd then u on a task: its agent badge comes back", async ({ page }) => {
    await openApp(page);
    await typeTask(page, "Order a replacement water filter");
    await expect(badge(page)).toHaveCount(1, { timeout: 15_000 });
    await enableVim(page);
    await vim(page, "/water<CR>");
    // Well within the save debounce, so the agent never sees the task deleted.
    await page.keyboard.type("ddu");
    await expect(badge(page)).toHaveCount(1);
    expect(await savedNote(page)).toBe("- [ ] Order a replacement water filter");
  });

  test("the status bar shows the mode, pending keys and macro recording", async ({ page }) => {
    await openApp(page);
    await enableVim(page);
    await vim(page, "i");
    await expectMode(page, "insert");
    await vim(page, "<Esc>v");
    await expectMode(page, "visual");
    await vim(page, "<Esc>V");
    await expectMode(page, "visual-line");
    await vim(page, "<C-v>");
    await expectMode(page, "visual-block");
    await vim(page, "<Esc>R");
    await expectMode(page, "replace");
    await vim(page, "<Esc>");
    await expectMode(page, "normal");
    await expect(status(page)).toContainText("NORMAL");

    const pending = page.getByTestId("status-vim-pending");
    await vim(page, "2");
    await expect(pending).toHaveText("2");
    await vim(page, "d");
    await expect(pending).toHaveText("2d");
    await vim(page, "<Esc>");
    await expect(pending).toHaveCount(0);
    await vim(page, '"a');
    await expect(pending).toHaveText('"a');
    await vim(page, "yy");
    await expect(pending).toHaveCount(0);

    await vim(page, "qq");
    await expect(page.getByTestId("status-vim-recording")).toHaveText("recording @q");
    await vim(page, "q");
    await expect(page.getByTestId("status-vim-recording")).toHaveCount(0);
  });

  test(":w saves, :e opens a note, gt switches tabs, :q and :wq close tabs", async ({ page }) => {
    await openApp(page);
    await enableVim(page);
    await vim(page, "ggApay rent<Esc>:w<CR>");
    expect(await savedNote(page)).toBe("- [ ] pay rent");

    await vim(page, ":e Garden Redesign<CR>");
    await expect(noteTitle(page)).toHaveValue("Garden Redesign");
    await expect(page.getByTestId("tab")).toHaveCount(1);

    await vim(page, ":tabe Reading List<CR>");
    await expect(noteTitle(page)).toHaveValue("Reading List");
    await expect(page.getByTestId("tab")).toHaveCount(2);
    await page.locator(".cm-content").click();
    await vim(page, "<Esc>gt");
    await expect(noteTitle(page)).toHaveValue("Garden Redesign");
    await page.locator(".cm-content").click();
    await vim(page, "<Esc>gT");
    await expect(noteTitle(page)).toHaveValue("Reading List");

    await page.locator(".cm-content").click();
    await vim(page, "<Esc>:q<CR>");
    await expect(page.getByTestId("tab")).toHaveCount(1);
    await expect(noteTitle(page)).toHaveValue("Garden Redesign");

    await page.locator(".cm-content").click();
    await vim(page, "<Esc>GoA note from vim<Esc>:wq<CR>");
    await expect(page.getByTestId("tab")).toHaveCount(0);
    const garden = await page.evaluate(() =>
      window.__ddlMock!.listPaths().find((p) => p.endsWith("Garden Redesign.md")),
    );
    await expect
      .poll(() => page.evaluate((p) => window.__ddlMock!.readNote(p!), garden))
      .toMatch(/\nA note from vim$/);
  });

  test(":e without a note opens the quick switcher", async ({ page }) => {
    await openApp(page);
    await enableVim(page);
    await vim(page, ":e<CR>");
    await expect(page.getByTestId("switcher")).toBeVisible();
  });

  test("Escape closes the palette without changing the vim mode", async ({ page }) => {
    await openApp(page);
    await enableVim(page);
    await vim(page, "A");
    await expectMode(page, "insert");
    await page.keyboard.press("ControlOrMeta+P");
    await expect(page.getByTestId("palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette")).toBeHidden();
    await expectMode(page, "insert");
    await page.keyboard.type("still typing", { delay: 5 });
    await vim(page, "<Esc>");
    expect(await savedNote(page)).toBe("- [ ] still typing");
  });

  test("a vimrc mapping takes effect and survives a reload", async ({ page }) => {
    await openApp(page);
    await enableVim(page);
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByTestId("settings-nav-editor").click();
    await page.getByTestId("setting-vimrc").click();
    await page.keyboard.type('" leave insert mode\nimap jj <Esc>\nset bogusoption', { delay: 5 });
    await expect(page.getByTestId("vimrc-problems")).toContainText(
      "Line 3: Unknown option: bogusoption",
    );
    await page.keyboard.press("Escape");

    await page.locator(".cm-content").click();
    await vim(page, "ggAhijj");
    await expectMode(page, "normal");
    expect(await savedNote(page)).toBe("- [ ] hi");

    await page.reload();
    await expect(page.getByTestId("note-title")).toBeVisible();
    await expectMode(page, "normal");
    await page.locator(".cm-content").click();
    await vim(page, "ggAokjj");
    await expectMode(page, "normal");
    await expect(status(page)).toContainText("NORMAL");
  });
});

test.describe("vim and the system clipboard", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test('"+ and "* registers read and write the clipboard, set clipboard=unnamed mirrors yanks', async ({
    page,
  }) => {
    await openApp(page);
    await enableVim(page);
    await vim(page, "ggAfirst line<Esc>");
    await vim(page, '"+yy');
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("- [ ] first line\n");

    await page.evaluate(() => navigator.clipboard.writeText("from elsewhere"));
    await vim(page, '$"*');
    // A person pauses between naming the register and pasting; the clipboard read is async.
    await page.waitForTimeout(150);
    await vim(page, "p");
    expect(await savedNote(page)).toBe("- [ ] first linefrom elsewhere");

    await vim(page, ":set clipboard=unnamed<CR>");
    await vim(page, "0yiw");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("-");
  });
});

test.describe("vim and app shortcuts where Mod is Ctrl", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" });
      Object.defineProperty(Navigator.prototype, "userAgentData", {
        get: () => ({ platform: "Windows" }),
      });
    });
  });

  test("normal mode keeps the Ctrl keys vim binds; other shortcuts and insert mode keep the app's", async ({
    page,
  }) => {
    await openApp(page);
    await enableVim(page);
    await vim(page, "ggAone<CR>two<CR>three<Esc>gg");
    // Ctrl-O is the quick switcher's shortcut, but vim's jump back in normal mode.
    await vim(page, "G");
    await page.keyboard.press("Control+o");
    await expect(page.getByTestId("switcher")).toBeHidden();
    await vim(page, "x");
    expect(await savedNote(page)).toBe(" [ ] one\n- [ ] two\n- [ ] three");

    // Ctrl-S isn't bound by vim: the app saves.
    await vim(page, "ifoo<Esc>");
    await page.keyboard.press("Control+s");
    await waitForSaved(page);

    // In insert mode app shortcuts win.
    await vim(page, "i");
    await page.keyboard.press("Control+o");
    await expect(page.getByTestId("switcher")).toBeVisible();
  });
});
