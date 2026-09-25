import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openApp } from "./helpers";

/**
 * Settings → Vault → Import from Obsidian against the in-browser mock, with the real keyboard.
 * Screenshots: DDL_IMPORT_SHOTS=/some/dir pnpm --filter @ddl/web exec playwright test obsidian
 */

const SHOTS = process.env.DDL_IMPORT_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page
    .getByTestId(/settings-modal|vault-switch/)
    .first()
    .screenshot({
      path: join(SHOTS, `${name}.png`),
    });
}

type MockHook = "setPairedDevice" | "setSyncing" | "setVaultLockedByEnv";

async function mockHook(page: Page, hook: MockHook, on: boolean): Promise<void> {
  await page.evaluate(
    ([name, value]) => {
      const hooks = window.__ddlMock as unknown as Record<string, (on: boolean) => void>;
      hooks[name as string]?.(value as boolean);
    },
    [hook, on] as const,
  );
}

/** "Import from Obsidian…" from the command palette. */
async function openImport(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+P");
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await page.keyboard.type("Import from Obsidian", { delay: 5 });
  await expect(page.getByTestId("palette-item").first()).toHaveText("Import from Obsidian…");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("settings-vault")).toBeVisible();
}

async function preview(page: Page, source: string): Promise<void> {
  await page.getByTestId("import-source").click();
  await page.keyboard.type(source, { delay: 5 });
  await page.keyboard.press("Enter");
}

test.describe("import from Obsidian", () => {
  test("preview, import with progress, cancel, import again, then switch to the new vault", async ({
    page,
  }) => {
    await openApp(page);
    await openImport(page);
    await expect(page.getByTestId("vault-current")).toContainText("/Users/me/Demo Vault");
    await expect(page.getByTestId("vault-imported")).toHaveCount(0);

    await preview(page, "~/Obsidian Notebook");
    const report = page.getByTestId("import-report");
    await expect(report).toBeVisible();
    await expect(page.getByTestId("report-stats")).toContainText("Notes41");
    await expect(page.getByTestId("report-settings")).toContainText(
      "Journal/Daily, named YYYY/MM/YYYY-MM-DD",
    );
    await expect(page.getByTestId("report-plugins")).toContainText("DataviewPartlyQueries");
    await expect(page.getByTestId("report-plugins")).toContainText("Word Sprint");
    await expect(page.getByTestId("report-canvases")).toContainText("don't open here yet");
    const carryOver = page.getByTestId("report-carry-over");
    await expect(carryOver).toContainText("/Users/me/Demo Vault, stays exactly as it is");
    await expect(carryOver).toContainText("under “From Daily Do List”");
    await expect(page.getByTestId("report-watched-tasks")).toContainText("3 open tasks");
    await expect(page.getByTestId("report-warnings")).toContainText("(Daily Do List)");
    await expect(page.getByTestId("import-destination")).toHaveValue(
      "/Users/me/Obsidian Notebook (Daily Do List)",
    );
    await shot(page, "1-report");
    for (const [i, id] of [
      "report-settings",
      "report-carry-over",
      "import-destination",
    ].entries()) {
      await page.getByTestId(id).scrollIntoViewIfNeeded();
      await shot(page, `1-report-${i + 2}`);
    }

    await page.getByTestId("import-start").click();
    await expect(page.getByTestId("import-phase")).toHaveText("Copying files…");
    await expect(page.getByTestId("import-counts")).toContainText(/\d+ of \d+ files/);
    await shot(page, "2-progress");
    await page.getByTestId("import-cancel").click();
    await expect(page.getByTestId("import-stopped")).toContainText("The import was cancelled");

    await page.getByTestId("import-start-over").click();
    await page.getByTestId("import-start").click();
    await expect(page.getByTestId("import-result")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("import-result")).toContainText("64 files");
    await shot(page, "3-result");

    await page.getByTestId("switch-vault").click();
    const switching = page.getByTestId("vault-switch");
    await expect(switching).toContainText("Switching to Obsidian Notebook (Daily Do List)");
    await expect(page.getByTestId("vault-switch-state")).toHaveText("Reconnecting…");
    await shot(page, "4-switching");
    await page.keyboard.press("Escape");
    await expect(switching).toBeVisible();

    // The page reloads on the new vault once the daemon is back.
    await expect(page.getByTestId("toast").filter({ hasText: "Now on" })).toContainText(
      "Your previous vault is kept untouched at /Users/me/Demo Vault",
      { timeout: 15_000 },
    );
    await openImport(page);
    await expect(page.getByTestId("vault-current")).toContainText(
      "/Users/me/Obsidian Notebook (Daily Do List)",
    );
    await expect(page.getByTestId("vault-imported")).toContainText("/Users/me/Obsidian Notebook");
    await expect(page.getByTestId("vault-previous")).toContainText("/Users/me/Demo Vault");
    await page.getByTestId("vault-update").click();
    await expect(page.getByTestId("update-report")).toContainText("1 new, 1 changed");
    await expect(page.getByTestId("vault-imported")).toContainText("last updated");
    await shot(page, "5-imported-vault");
  });

  test("says why when the path is wrong, and while sync or DDL_VAULT keep the vault", async ({
    page,
  }) => {
    await openApp(page);
    await openImport(page);
    await preview(page, "Obsidian Notebook");
    await expect(page.getByTestId("import-problem")).toHaveText(
      "The Obsidian vault must be an absolute path (or start with ~/)",
    );
    await page.getByTestId("import-source").click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("~/Plain notes", { delay: 5 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("report-warnings")).toContainText("no .obsidian folder");
    await expect(page.getByTestId("report-plugins")).toContainText("No community plugins");

    await mockHook(page, "setSyncing", true);
    await page.getByTestId("import-start").click();
    await expect(page.getByTestId("import-result")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByTestId("switch-syncing")).toContainText("Turn sync off first");
    await expect(page.getByTestId("switch-vault")).toBeDisabled();
    await shot(page, "6-sync-on");

    await mockHook(page, "setSyncing", false);
    await mockHook(page, "setVaultLockedByEnv", true);
    // Settings asks the daemon again when it opens.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-modal")).toBeHidden();
    await openImport(page);
    await expect(page.getByTestId("switch-syncing")).toHaveCount(0);
    await expect(page.getByTestId("switch-locked")).toContainText("set DDL_VAULT to");
    await expect(page.getByTestId("switch-vault")).toBeDisabled();
  });

  test("a paired device sees why it can't import, and nothing to press", async ({ page }) => {
    await openApp(page);
    await mockHook(page, "setPairedDevice", true);
    await openImport(page);
    await expect(page.getByTestId("vault-forbidden")).toContainText(
      "Only the Mac that runs Daily Do List",
    );
    await expect(page.getByTestId("import-source")).toBeDisabled();
    const reason = page
      .getByTestId("disabled-reason")
      .filter({ has: page.getByTestId("import-preview") });
    await expect(reason).toHaveAttribute("data-tooltip", /Only the Mac that runs Daily Do List/);
    await shot(page, "7-paired-device");
  });
});
