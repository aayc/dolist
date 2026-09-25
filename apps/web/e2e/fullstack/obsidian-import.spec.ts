/**
 * Importing from Obsidian against the real daemon: the harness's synthetic Obsidian vault (see
 * packages/agent/scripts/e2e-fullstack.ts) is previewed and imported into a new folder next to it.
 * The harness fixes its vault with DDL_VAULT, so the switch says how to change it instead.
 * Real keyboard throughout. Run with `pnpm --filter @ddl/web e2e:fullstack`.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

async function openApp(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("note-title")).toBeVisible();
  await page.waitForFunction(() =>
    window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
  );
}

async function typeInto(page: Page, testId: string, text: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text, { delay: 2 });
}

test("preview and import a synthetic Obsidian vault; DDL_VAULT keeps the switch manual", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const port = new URL(String(testInfo.project.use.baseURL)).port;
  const root = realpathSync(join(tmpdir(), `ddl-e2e-obsidian-${port}`));
  const source = join(root, "Obsidian Notebook");
  const destination = join(root, "Imported");
  await openApp(page);

  await page.keyboard.press("ControlOrMeta+P");
  await expect(page.getByTestId("palette-input")).toBeFocused();
  await page.keyboard.type("Import from Obsidian", { delay: 5 });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("vault-current")).toContainText("set by DDL_VAULT");
  await expect(page.getByTestId("vault-imported")).toHaveCount(0);

  await typeInto(page, "import-source", source);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("import-report")).toBeVisible();
  await expect(page.getByTestId("report-settings")).toContainText(
    "Journal/Daily, named YYYY/MM/YYYY-MM-DD",
  );
  await expect(page.getByTestId("report-settings")).toContainText("vim mode on");
  const plugins = page.getByTestId("report-plugins");
  await expect(plugins).toContainText("DataviewPartlyQueries show as text.");
  await expect(plugins).toContainText("ExcalidrawWorks here");
  await expect(plugins).toContainText("homemade-widget");
  await expect(page.getByTestId("report-canvases")).toContainText("1 canvas");
  await expect(page.getByTestId("report-carry-over")).toContainText("stays exactly as it is");

  await typeInto(page, "import-destination", destination);
  await page.getByTestId("import-start").click();
  const result = page.getByTestId("import-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toContainText("were copied");
  expect(existsSync(join(destination, ".obsidian/app.json"))).toBe(true);
  expect(readFileSync(join(destination, "Ideas.md"), "utf8")).toBe("# Ideas\n- A garden bench\n");
  const manifest = JSON.parse(
    readFileSync(join(destination, ".daily-do-list/import/obsidian.json"), "utf8"),
  ) as { source: string; previousVault?: string };
  expect(manifest.source).toBe(source);
  expect(manifest.previousVault).toBeTruthy();

  await expect(page.getByTestId("switch-locked")).toContainText(`set DDL_VAULT to ${destination}`);
  await expect(page.getByTestId("switch-vault")).toBeDisabled();

  // A second import can't go into the same folder: the daemon's reason shows.
  await page.getByTestId("import-start-over").click();
  await page.getByTestId("import-start").click();
  await expect(page.getByTestId("import-problem")).toHaveText(`${destination} isn't empty`);
});
