/**
 * The agent anywhere against the real daemons: the served daemon (this device), a second daemon
 * playing the always-on machine, and a sync service, all started by
 * packages/agent/scripts/e2e-fullstack.ts, whose loopback helper (two ports above the served
 * daemon) hands out what a user would get elsewhere: the vault's sync credentials and a code
 * printed on the machine, and stopping and starting the machine. Run with
 * `pnpm --filter @ddl/web e2e:fullstack`.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

/** A handover goes through the lease: the holder yields at its next renewal (about half a minute). */
const HANDOVER_MS = 60_000;

interface AlwaysOn {
  sync: { url: string; vault: string; token: string };
  machine: { name: string; url: string };
}

/** The served daemon's port, from the project's base URL. */
function portOf(baseURL: string | undefined): number {
  return Number(new URL(baseURL ?? "http://127.0.0.1:4175").port);
}

function helperUrl(baseURL: string | undefined, path: string): string {
  return `http://127.0.0.1:${portOf(baseURL) + 2}${path}`;
}

/** A name the served daemon answers to besides loopback, mapped to 127.0.0.1 for the browser. */
function remoteHost(baseURL: string | undefined): string {
  return `laptop.e2e.example:${portOf(baseURL)}`;
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

test.beforeAll(async ({ request, baseURL }) => {
  alwaysOn = (await (await request.get(helperUrl(baseURL, "/always-on"))).json()) as AlwaysOn;
});

test.afterAll(async ({ request, baseURL }) => {
  // The other fullstack specs expect the daemon standalone.
  await request.post(helperUrl(baseURL, "/always-on/reset"));
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
  await expect(page.getByTestId("sync-saved")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("sync-token")).toHaveValue("");
  await expect(page.getByTestId("sync-token-saved")).toBeVisible();
  await expect(page.getByTestId("sync-state")).toHaveText("Up to date", { timeout: 30_000 });

  await page.keyboard.press("Escape");
  await openPanel(page);
  await expect(await tooltipOf(page, page.getByTestId("placement-toggle"))).toHaveText(
    "Set up an always-on machine in Settings",
  );
});

test("Settings → Always-on machine pairs with a code printed on the machine", async ({
  page,
  request,
  baseURL,
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

  const issued = await request.post(helperUrl(baseURL, "/always-on/machine-code"));
  expect(issued.status()).toBe(201);
  const { code } = (await issued.json()) as { code: string };
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

test("the toggle hands the agent to the machine and takes it back", async ({ page }) => {
  test.setTimeout(4 * HANDOVER_MS);
  await openApp(page);
  await openPanel(page);
  // Set to this device, it took the agent over from the machine once sync came on.
  await expect(line(page)).toHaveText("Running on this device", { timeout: HANDOVER_MS });

  await page.getByTestId("placement-toggle-always_on_machine").click();
  await expect(page.getByTestId("placement-toggle")).toHaveAttribute(
    "data-selected",
    "always_on_machine",
  );
  await expect(line(page)).toHaveText(`Running on ${alwaysOn.machine.name}`, {
    timeout: HANDOVER_MS,
  });

  await page.getByTestId("placement-toggle-this_device").click();
  await expect(line(page)).toHaveText(`Taking over from ${alwaysOn.machine.name}…`, {
    timeout: 10_000,
  });
  await expect(line(page)).toHaveText("Running on this device", { timeout: HANDOVER_MS });
});

test("relayed to the machine, this device acts on its agent", async ({ page }) => {
  test.setTimeout(4 * HANDOVER_MS);
  await openApp(page);
  await openPanel(page);
  await expect(line(page)).toHaveText("Running on this device", { timeout: HANDOVER_MS });
  await page.getByTestId("placement-toggle-always_on_machine").click();
  await expect(page.getByTestId("agent-location")).toHaveAttribute("data-relay", "connected", {
    timeout: HANDOVER_MS,
  });
  await expect(line(page)).toHaveText(`Running on ${alwaysOn.machine.name}`, {
    timeout: HANDOVER_MS,
  });
  await expect(page.getByTestId("agent-banner")).toHaveCount(0);
  // The merged status carries the machine's agent mode too ("mock" in this harness).
  await expect(page.getByTestId("status-agent").locator("span").first()).toHaveText(
    `Agent on ${alwaysOn.machine.name}`,
  );

  // A reply to the machine's orchestrator goes through the relay, and its answer comes back.
  await page.getByTestId("inbox-orchestrator").click();
  const chat = page.getByTestId("orchestrator-view");
  const input = page.getByTestId("composer-input");
  await expect(input).toBeEnabled();
  const answers = chat.locator('.message.is-agent[data-testid="message-text"]');
  const before = await answers.count();
  await input.click();
  await page.keyboard.type("What are you working on?", { delay: 5 });
  await page.keyboard.press("Enter");
  await expect(
    chat.locator(".message.is-user").filter({ hasText: "What are you working on?" }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(chat.locator(".message-failed")).toHaveCount(0);
  await expect(answers).toHaveCount(before + 1, { timeout: 30_000 });
  await page.getByTestId("thread-back").click();
});

test("when the machine goes away, this device shows its work read-only until it's back", async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(4 * HANDOVER_MS);
  await openApp(page);
  await openPanel(page);
  const location = page.getByTestId("agent-location");
  await expect(location).toHaveAttribute("data-relay", "connected", { timeout: HANDOVER_MS });

  expect((await request.post(helperUrl(baseURL, "/always-on/machine/stop"))).status()).toBe(200);
  await expect(location).toHaveAttribute("data-relay", "unreachable", { timeout: HANDOVER_MS });
  await expect(page.getByTestId("agent-banner")).toContainText(
    "The always-on machine can't be reached — showing the last synced state",
  );
  await expect(line(page)).toHaveText(`${alwaysOn.machine.name} can't be reached`);
  await expect(page.getByTestId("status-agent").locator("span").first()).toHaveText(
    "Agent unreachable",
  );
  await page.getByTestId("inbox-orchestrator").click();
  await expect(page.getByTestId("composer-input")).toBeDisabled();
  await expect(page.getByTestId("composer-input")).toHaveAttribute(
    "placeholder",
    "The always-on machine can't be reached",
  );
  await page.getByTestId("thread-back").click();

  expect((await request.post(helperUrl(baseURL, "/always-on/machine/start"))).status()).toBe(200);
  await expect(location).toHaveAttribute("data-relay", "connected", { timeout: HANDOVER_MS });
  await expect(page.getByTestId("agent-banner")).toHaveCount(0);

  // Back to this device for what follows.
  await page.getByTestId("placement-toggle-this_device").click();
  await expect(line(page)).toHaveText("Running on this device", { timeout: 2 * HANDOVER_MS });
});

test("Settings → Remote access and Devices: a code for a new device, and revoking it", async ({
  page,
  request,
  baseURL,
}) => {
  const host = remoteHost(baseURL);
  await openApp(page);
  await openSettings(page, "remote");
  await typeInto(page, "remote-host-input", host);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("remote-host")).toHaveText([host]);

  await openSettings(page, "devices");
  await typeInto(page, "pairing-code-name", "E2E app");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pairing-code-url")).toHaveText(`https://${host}`);
  const code = await page.getByTestId("pairing-code").innerText();
  await expect(page.getByTestId("pairing-code-expiry")).toHaveText(/^Expires in [45]:\d\d$/);

  // The new device (a native app) exchanges the code for its token.
  const paired = await request.post("/api/pair", {
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
  const refused = await request.get("/api/health", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(refused.status()).toBe(401);
});

test.describe("a browser on a remote host", () => {
  test("gets the pairing screen, never the token", async ({ playwright, baseURL }) => {
    // Its own browser, which resolves the remote host's name to this machine.
    const browser = await playwright.chromium.launch({
      ...(test.info().project.use.channel ? { channel: test.info().project.use.channel } : {}),
      args: ["--host-resolver-rules=MAP laptop.e2e.example 127.0.0.1"],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`http://${remoteHost(baseURL)}/`);
      await expect(page.getByTestId("pairing-screen")).toBeVisible();
      expect(await page.locator('meta[name="ddl-token"]').count()).toBe(0);
      await expect(page.locator('meta[name="ddl-auth"]')).toHaveAttribute("content", "pairing");
      await expect(page.getByTestId("pairing-code-input")).toBeFocused();
      await page.keyboard.type("ABCD2345");
      await page.keyboard.press("Enter");
      // Over plain http the page's Origin isn't the remote host's https origin, so the daemon
      // refuses; a real remote host is https (tailscale serve).
      await expect(page.getByTestId("pairing-error")).toHaveText(
        "Daily Do List refused this page's address. Open it at one of its remote hosts.",
      );
    } finally {
      await browser.close();
    }
  });

  // The device cookie is __Host-ddl-device (Secure): pairing a browser needs https in front of
  // the daemon, as tailscale serve provides. Enable once the harness has a TLS proxy.
  test.fixme("pairs over https, uses the cookie, and goes back to pairing when revoked", () => {});
});
