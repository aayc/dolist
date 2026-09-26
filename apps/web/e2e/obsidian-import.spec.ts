import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Daemon, expect, type Page, syncVault, test } from "./fixtures";
import { openApp } from "./helpers";

/**
 * Settings → Vault → Import from Obsidian against the real daemon, with the real keyboard: the
 * harness builds the daemon's synthetic Obsidian vault next to the test's vault
 * (`DaemonSpec.obsidian`), and the switch restarts the daemon on the imported vault.
 * Screenshots: DDL_IMPORT_SHOTS=/some/dir pnpm --filter @ddl/web exec playwright test obsidian
 */

const SHOTS = process.env.DDL_IMPORT_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page
    .getByTestId(/settings-modal|vault-switch/)
    .first()
    .screenshot({ path: join(SHOTS, `${name}.png`) });
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

async function typeInto(page: Page, testId: string, text: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text, { delay: 2 });
}

async function preview(page: Page, source: string): Promise<void> {
  await typeInto(page, "import-source", source);
  await page.keyboard.press("Enter");
}

/** Where the harness put the synthetic Obsidian vault, as the daemon reports it (real path). */
function obsidianOf(daemon: Daemon): string {
  return realpathSync(daemon.obsidian!);
}

test.use({ daemonSpec: { obsidian: true } });

test("preview, import, switch to the new vault, then update it from Obsidian", async ({
  page,
  daemon,
}) => {
  test.setTimeout(90_000);
  const source = obsidianOf(daemon);
  const destination = `${source} (Daily Do List)`;
  await openApp(page);
  await openImport(page);
  await expect(page.getByTestId("vault-current")).toContainText(daemon.vault);
  await expect(page.getByTestId("vault-current")).not.toContainText("set by DDL_VAULT");
  await expect(page.getByTestId("vault-imported")).toHaveCount(0);

  await preview(page, source);
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
  await expect(page.getByTestId("import-destination")).toHaveValue(destination);
  await shot(page, "1-report");

  await page.getByTestId("import-start").click();
  const result = page.getByTestId("import-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toContainText("were copied");
  await shot(page, "3-result");
  expect(existsSync(join(destination, ".obsidian/app.json"))).toBe(true);
  expect(readFileSync(join(destination, "Ideas.md"), "utf8")).toBe("# Ideas\n- A garden bench\n");
  const manifest = JSON.parse(
    readFileSync(join(destination, ".daily-do-list/import/obsidian.json"), "utf8"),
  ) as { source: string; previousVault?: string };
  expect(manifest.source).toBe(source);
  expect(manifest.previousVault).toBeTruthy();

  // The daemon restarts on the new vault (the harness plays its supervisor); nothing closes the
  // overlay meanwhile, and the page reloads once the daemon is back.
  await page.getByTestId("switch-vault").click();
  const switching = page.getByTestId("vault-switch");
  await expect(switching).toContainText("Switching to Obsidian Notebook (Daily Do List)");
  await shot(page, "4-switching");
  await page.keyboard.press("Escape");
  await expect(switching).toBeVisible();
  await expect(page.getByTestId("toast").filter({ hasText: "Now on" })).toContainText(
    `Your previous vault is kept untouched at ${daemon.vault}`,
    { timeout: 30_000 },
  );
  await openImport(page);
  await expect(page.getByTestId("vault-current")).toContainText(destination);
  await expect(page.getByTestId("vault-imported")).toContainText(source);
  await expect(page.getByTestId("vault-previous")).toContainText(daemon.vault);

  // Obsidian changed one note and added another since.
  writeFileSync(join(source, "Ideas.md"), "# Ideas\n- A garden bench\n- A rain barrel\n");
  writeFileSync(join(source, "Pond.md"), "# Pond\n");
  await page.getByTestId("vault-update").click();
  await expect(page.getByTestId("update-report")).toContainText("1 new and 1 changed");
  await expect(page.getByTestId("vault-imported")).toContainText("last updated");
  await shot(page, "5-imported-vault");
});

test("says why when the path is wrong, and while sync keeps the vault", async ({
  page,
  daemon,
}) => {
  await openApp(page);
  await openImport(page);
  await preview(page, "Obsidian Notebook");
  await expect(page.getByTestId("import-problem")).toHaveText(
    "The source must be an absolute path (or start with ~/)",
  );
  await preview(page, join(realpathSync(daemon.root), "Plain notes"));
  await expect(page.getByTestId("report-warnings")).toContainText("no .obsidian folder");
  await expect(page.getByTestId("report-plugins")).toContainText("No community plugins");

  const sync = await syncVault();
  const setup = await daemon.api("PUT", "/api/device/sync", sync);
  expect(setup.status).toBe(200);
  await page.getByTestId("import-start").click();
  await expect(page.getByTestId("import-result")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByTestId("switch-syncing")).toContainText("Turn sync off first");
  await expect(page.getByTestId("switch-vault")).toBeDisabled();
  await shot(page, "6-sync-on");
});

test.describe("with DDL_VAULT set", () => {
  test.use({ daemonSpec: { obsidian: true, lockVault: true } });

  test("the switch says how to change it, and a second import needs an empty folder", async ({
    page,
    daemon,
  }) => {
    const destination = join(realpathSync(daemon.root), "Imported");
    await openApp(page);
    await openImport(page);
    await expect(page.getByTestId("vault-current")).toContainText("set by DDL_VAULT");
    await preview(page, obsidianOf(daemon));
    await expect(page.getByTestId("import-report")).toBeVisible();
    await typeInto(page, "import-destination", destination);
    await page.getByTestId("import-start").click();
    await expect(page.getByTestId("import-result")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("switch-locked")).toContainText(
      `set DDL_VAULT to ${destination}`,
    );
    await expect(page.getByTestId("switch-vault")).toBeDisabled();

    await page.getByTestId("import-start-over").click();
    await page.getByTestId("import-start").click();
    await expect(page.getByTestId("import-problem")).toHaveText(`${destination} isn't empty`);
  });
});

test("a paired device sees why it can't import, and nothing to press", async ({ page, daemon }) => {
  // A device paired with a code (a native app) opens the app with its own token.
  const code = await daemon.api<{ code: string }>("POST", "/api/pairing-codes", { name: "iPad" });
  const paired = await fetch(`${daemon.url}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.body.code, name: "iPad", kind: "app" }),
  });
  expect(paired.status).toBe(201);
  const { token } = (await paired.json()) as { token: string };
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(daemon.token, token);
      await route.fulfill({ response, body: html });
    },
  );
  await openApp(page);
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
