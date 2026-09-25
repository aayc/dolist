/**
 * The agent anywhere against the real daemons: the served daemon (this device), a second daemon
 * playing the always-on machine, and a sync service, all started by
 * packages/agent/scripts/e2e-fullstack.ts, whose loopback helper (port + 2) hands out what a user
 * would get elsewhere: the vault's sync credentials and a code printed on the machine. Needs the
 * daemon's remote access and pairing (S1) and placement and machine link (S2); the handover test
 * also needs the relay (S3). Run with `pnpm --filter @ddl/web e2e:fullstack`.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

const DAEMON = "http://127.0.0.1:4175";
const HELPER = "http://127.0.0.1:4177";
/** A name this daemon answers to besides loopback, mapped to 127.0.0.1 for the browser below. */
const REMOTE_HOST = "laptop.e2e.example:4175";
/** A handover goes through the lease: the holder yields at its next renewal (about half a minute). */
const HANDOVER_MS = 60_000;

interface AlwaysOn {
  sync: { url: string; vault: string; token: string };
  machine: { name: string; url: string };
}

async function openApp(page: Page, url = "/"): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId("note-title")).toBeVisible();
  await page.waitForFunction(() =>
    window.__ddlPerf?.measures.some((m) => m.name === "app:interactive"),
  );
}

/** The agent panel stays open across reloads: open it only when it's closed. */
async function openPanel(page: Page): Promise<void> {
  if ((await page.getByTestId("right-panel").count()) === 0) {
    await page.keyboard.press("ControlOrMeta+Shift+A");
  }
  await expect(page.getByTestId("agent-location")).toBeVisible();
}

async function openSettings(page: Page, section: string): Promise<void> {
  if ((await page.getByTestId("settings-modal").count()) === 0) {
    await page.keyboard.press("ControlOrMeta+,");
  }
  await page.getByTestId(`settings-nav-${section}`).click();
  await expect(page.getByTestId(`settings-${section}`)).toBeVisible();
}

async function typeInto(page: Page, testId: string, text: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text, { delay: 5 });
}

async function tooltipOf(page: Page, target: Locator): Promise<Locator> {
  const box = await target.boundingBox();
  if (!box) throw new Error("target isn't visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  const tip = page.locator("#ddl-tooltip");
  await expect(tip).toHaveClass(/\bis-visible\b/);
  return tip.locator(".tooltip-text");
}

function line(page: Page): Locator {
  return page.getByTestId("agent-location-line-text");
}

let alwaysOn: AlwaysOn;

test.beforeAll(async ({ request }) => {
  alwaysOn = (await (await request.get(`${HELPER}/always-on`)).json()) as AlwaysOn;
});

test.afterAll(async ({ request }) => {
  // The other fullstack specs expect the daemon standalone.
  await request.post(`${HELPER}/always-on/reset`);
});

test("without sync, the agent is held on this device, and the toggle says why", async ({
  page,
}) => {
  await openApp(page);
  await openPanel(page);
  const toggle = page.getByTestId("placement-toggle");
  await expect(toggle).toHaveAttribute("data-disabled", "true");
  await expect(await tooltipOf(page, toggle)).toHaveText("This device doesn't sync");
  await expect(line(page)).toHaveText("Running on this device");
  await expect(page.getByTestId("agent-location-line-action")).toHaveText("Set up sync");

  await openSettings(page, "location");
  await expect(page.getByTestId("readiness-here").getByTestId(/^readiness-/)).toHaveCount(5);
  await expect(page.getByTestId("readiness-credential")).toContainText("Present");
});

test("Settings → Sync connects this device to the sync service; the token stays write-only", async ({
  page,
}) => {
  await openApp(page);
  await openSettings(page, "sync");
  await expect(page.getByTestId("sync-state")).toHaveText("Off");
  await typeInto(page, "sync-url", alwaysOn.sync.url);
  await typeInto(page, "sync-vault", alwaysOn.sync.vault);
  await typeInto(page, "sync-token", alwaysOn.sync.token);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sync-saved")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("sync-token")).toHaveValue("");
  await expect(page.getByTestId("sync-token-saved")).toBeVisible();
  await expect(page.getByTestId("sync-state")).toHaveText("Up to date", { timeout: 20_000 });

  await page.keyboard.press("Escape");
  await openPanel(page);
  await expect(await tooltipOf(page, page.getByTestId("placement-toggle"))).toHaveText(
    "Set up an always-on machine in Settings",
  );
});

test("Settings → Always-on machine pairs with a code printed on the machine", async ({
  page,
  request,
}) => {
  await openApp(page);
  await openSettings(page, "machine");
  await typeInto(page, "machine-url", alwaysOn.machine.url);
  await typeInto(page, "machine-code", "ZZZZ-ZZZZ");
  await typeInto(page, "machine-name", alwaysOn.machine.name);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("machine-pair-error")).toContainText(
    "The always-on machine didn't accept that code",
  );

  const { code } = (await (await request.post(`${HELPER}/always-on/machine-code`)).json()) as {
    code: string;
  };
  await typeInto(page, "machine-code", code);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("machine-status-name")).toHaveText(alwaysOn.machine.name, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("machine-reachable")).toHaveText("Reachable");
  await expect(page.getByTestId("machine-version")).not.toHaveText("—");
  await expect(page.getByTestId("readiness-machine")).toBeVisible();

  // With sync and a machine, the toggle can hand the agent over.
  await page.keyboard.press("Escape");
  await openPanel(page);
  await expect(page.getByTestId("placement-toggle-always_on_machine")).toBeEnabled();
});

test("the toggle hands the agent to the machine and takes it back (needs the relay)", async ({
  page,
}) => {
  test.setTimeout(4 * HANDOVER_MS);
  await openApp(page);
  await openPanel(page);
  // Set to this device, it took the agent over from the machine when sync came on.
  await expect(line(page)).toHaveText("Running on this device", { timeout: HANDOVER_MS });

  await page.getByTestId("placement-toggle-always_on_machine").click();
  await expect(page.getByTestId("placement-toggle")).toHaveAttribute(
    "data-selected",
    "always_on_machine",
  );
  await expect(line(page)).toHaveText(`Running on ${alwaysOn.machine.name}`, {
    timeout: HANDOVER_MS,
  });
  await expect(page.getByTestId("agent-location")).toHaveAttribute("data-relay", "connected", {
    timeout: HANDOVER_MS,
  });
  await expect(page.getByTestId("agent-banner")).toHaveCount(0);
  await expect(page.getByTestId("status-agent")).toHaveText(`Agent on ${alwaysOn.machine.name}`);

  await page.getByTestId("placement-toggle-this_device").click();
  await expect(line(page)).toHaveText(`Taking over from ${alwaysOn.machine.name}…`, {
    timeout: 10_000,
  });
  await expect(line(page)).toHaveText("Running on this device", { timeout: HANDOVER_MS });
});

test("Settings → Remote access and Devices: a code for a new device, and revoking it", async ({
  page,
  request,
}) => {
  await openApp(page);
  await openSettings(page, "remote");
  await typeInto(page, "remote-host-input", REMOTE_HOST);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("remote-host")).toHaveText([REMOTE_HOST]);

  await openSettings(page, "devices");
  await typeInto(page, "pairing-code-name", "E2E app");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pairing-code-url")).toHaveText(`https://${REMOTE_HOST}`);
  const code = await page.getByTestId("pairing-code").innerText();
  await expect(page.getByTestId("pairing-code-expiry")).toHaveText(/^Expires in [45]:\d\d$/);

  // The new device (a native app) exchanges the code for its token.
  const paired = await request.post(`${DAEMON}/api/pair`, {
    data: { code, name: "Ignored: the code names it", kind: "app" },
  });
  expect(paired.status()).toBe(201);
  const { token } = (await paired.json()) as { token: string };
  await expect(page.getByTestId("device-paired")).toHaveText("Paired: E2E app.");
  const row = page.getByTestId("device-row").filter({ hasText: "E2E app" });
  await expect(row).toContainText("App");

  await row.getByTestId("device-revoke").click();
  await page.getByTestId("confirm-accept").click();
  await expect(row).toHaveCount(0);
  const refused = await request.get(`${DAEMON}/api/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(refused.status()).toBe(401);
});

test.describe("a browser on a remote host", () => {
  test.use({
    launchOptions: { args: ["--host-resolver-rules=MAP laptop.e2e.example 127.0.0.1"] },
  });

  test("gets the pairing screen, never the token", async ({ page }) => {
    await page.goto(`http://${REMOTE_HOST}/`);
    await expect(page.getByTestId("pairing-screen")).toBeVisible();
    expect(await page.locator('meta[name="ddl-token"]').count()).toBe(0);
    await expect(page.locator('meta[name="ddl-auth"]')).toHaveAttribute("content", "pairing");
    await page.keyboard.type("ABCD2345");
    await page.keyboard.press("Enter");
    // Over plain http the page's Origin isn't the remote host's https origin, so the daemon
    // refuses; a real remote host is https (tailscale serve), where the next test pairs.
    await expect(page.getByTestId("pairing-error")).toHaveText(
      "Daily Do List refused this page's address. Open it at one of its remote hosts.",
    );
  });

  // The device cookie is Secure (and __Host-): pairing a browser needs https in front of the
  // daemon, as tailscale serve provides. Enable once the harness has a TLS proxy.
  test.fixme("pairs over https, uses the cookie, and goes back to pairing when revoked", () => {});
});
