import { expect, type Locator, type Page, test } from "@playwright/test";
import { openApp } from "./helpers";

/**
 * Where the agent runs, the always-on machine, sync, devices, remote access and the pairing
 * screen, against the in-browser mock (`?mockRemote=` picks the device side's starting point, see
 * src/api/mock/mock-remote.ts). Real keyboard and mouse throughout.
 */

async function openPanel(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+A");
  await expect(page.getByTestId("inbox")).toBeVisible();
}

async function openSettings(page: Page, section: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId(`settings-nav-${section}`).click();
}

/** Types into a field with the real keyboard, replacing what's there. */
async function typeInto(page: Page, testId: string, text: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.keyboard.press("ControlOrMeta+A");
  if (text) await page.keyboard.type(text, { delay: 5 });
  else await page.keyboard.press("Backspace");
}

/** Hovers `target` with the real mouse and returns the tooltip that opens. */
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

test.describe("the orchestrator toggle", () => {
  test("flips where the orchestrator runs, showing the handover as it happens", async ({
    page,
  }) => {
    await openApp(page, "mockSpeed=1&mockRemote=ready");
    await openPanel(page);
    const toggle = page.getByTestId("placement-toggle");
    await expect(toggle).toHaveAttribute("data-selected", "this_device");
    await expect(line(page)).toHaveText("Running on this device");

    await page.getByTestId("placement-toggle-always_on_machine").click();
    await expect(toggle).toHaveAttribute("data-selected", "always_on_machine");
    await expect(line(page)).toHaveText("Handing the agent to vm-1…");
    await expect(line(page)).toHaveText("Running on vm-1", { timeout: 5_000 });
    expect(await (await tooltipOf(page, line(page))).textContent()).toBe(
      "vm-1 is the always-on machine",
    );

    await page.getByTestId("placement-toggle-this_device").click();
    await expect(line(page)).toHaveText("Taking over from vm-1…");
    await expect(line(page)).toHaveText("Running on this device", { timeout: 5_000 });
    await expect(page.getByTestId("agent-banner")).toHaveCount(0);
  });

  test("is held on this device until sync and a machine are set up, and says why", async ({
    page,
  }) => {
    await openApp(page, "mockRemote=none");
    await openPanel(page);
    const toggle = page.getByTestId("placement-toggle");
    await expect(toggle).toHaveAttribute("data-disabled", "true");
    await expect(page.getByTestId("placement-toggle-always_on_machine")).toBeDisabled();
    await expect(await tooltipOf(page, toggle)).toHaveText("This device doesn't sync");

    await page.getByTestId("agent-location-line-action").click();
    await expect(page.getByTestId("settings-sync")).toBeVisible();
    await typeInto(page, "sync-url", "https://vm-1.tailnet-name.ts.net:8443");
    await typeInto(page, "sync-vault", "vault_demo");
    await typeInto(page, "sync-token", "t0ken-for-tests");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sync-saved")).toBeVisible();
    await page.keyboard.press("Escape");

    await expect(await tooltipOf(page, toggle)).toHaveText(
      "Set up an always-on machine in Settings",
    );
    await expect(page.getByTestId("agent-location-line-action")).toHaveText(
      "Set up an always-on machine",
    );
    await page.getByTestId("agent-location-line-action").click();
    await expect(page.getByTestId("machine-pair-form")).toBeVisible();
  });

  test("offers running here when the machine can't be reached", async ({ page }) => {
    await openApp(page, "mockSpeed=4&mockRemote=relayed");
    await openPanel(page);
    await expect(line(page)).toHaveText("Running on vm-1");
    await page.evaluate(() => window.__ddlMock!.setMachineReachable(false));
    await expect(line(page)).toHaveText("vm-1 can't be reached");
    await expect(page.getByTestId("agent-banner")).toContainText(
      "The always-on machine can't be reached — showing the last synced state",
    );
    await page.getByTestId("agent-banner-run-here").click();
    await expect(line(page)).toHaveText("Running on this device", { timeout: 5_000 });
    await expect(page.getByTestId("placement-toggle")).toHaveAttribute(
      "data-selected",
      "this_device",
    );
    await expect(page.getByTestId("agent-banner")).toHaveCount(0);
  });

  test("says so when the machine no longer accepts this device, and pairs again", async ({
    page,
  }) => {
    await openApp(page, "mockSpeed=4&mockRemote=relayed");
    await openPanel(page);
    await page.evaluate(() => window.__ddlMock!.setMachineRejects(true));
    await expect(page.getByTestId("agent-banner")).toContainText(
      "The always-on machine no longer accepts this device — showing the last synced state",
    );
    await expect(line(page)).toHaveText("The always-on machine no longer accepts this device");
    await page.getByTestId("agent-banner-pair").click();
    await expect(page.getByTestId("machine-status")).toContainText(
      "no longer accepts this device's credential",
    );
    await page.getByTestId("machine-pair-again").click();
    await expect(page.getByTestId("machine-url")).toHaveValue("https://vm-1.tailnet-name.ts.net");
    await expect(page.getByTestId("machine-name")).toHaveValue("vm-1");
    await typeInto(page, "machine-code", "ABCD2345");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-pair-form")).toHaveCount(0);
    await expect(page.getByTestId("machine-error")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(line(page)).toHaveText("Running on vm-1");
    await expect(page.getByTestId("agent-banner")).toHaveCount(0);
  });

  test("says this is the always-on machine on the machine itself", async ({ page }) => {
    await openApp(page, "mockRemote=host");
    await openPanel(page);
    await expect(page.getByTestId("placement-host")).toHaveText("This is the always-on machine");
    await expect(page.getByTestId("placement-toggle")).toHaveCount(0);
    await expect(line(page)).toHaveText("Running here");
  });

  test("is read-only where an environment variable sets it", async ({ page }) => {
    await openApp(page, "mockRemote=locked");
    await openPanel(page);
    await expect(await tooltipOf(page, page.getByTestId("placement-toggle"))).toContainText(
      "DDL_AGENT_PLACEMENT",
    );
    await openSettings(page, "location");
    await expect(page.getByTestId("placement-locked")).toBeVisible();
    await page.getByTestId("settings-nav-remote").click();
    await expect(page.getByTestId("remote-locked")).toBeVisible();
    await expect(page.getByTestId("remote-host-input")).toHaveCount(0);
    await page.getByTestId("settings-nav-sync").click();
    await expect(page.getByTestId("sync-locked")).toBeVisible();
    await expect(page.getByTestId("sync-url")).toBeDisabled();
  });
});

test.describe("while another device runs the agent", () => {
  test("the panel shows the synced state read-only, and actions say why", async ({ page }) => {
    await openApp(page, "mockRemote=elsewhere");
    await openPanel(page);
    await expect(page.getByTestId("agent-banner")).toHaveText(
      "The agent is running on Work laptop — showing the last synced state",
    );
    await page.getByTestId("inbox-orchestrator").click();
    const input = page.getByTestId("composer-input");
    await expect(input).toBeDisabled();
    await expect(input).toHaveAttribute("placeholder", "The agent is running on Work laptop");
    await expect(await tooltipOf(page, page.getByTestId("disabled-reason").last())).toHaveText(
      "The agent is running on Work laptop",
    );
  });
});

test.describe("settings", () => {
  test("Agent location: the toggle, where it runs, and this device's readiness", async ({
    page,
  }) => {
    await openApp(page, "mockRemote=unready");
    await openSettings(page, "location");
    await expect(page.getByTestId("settings-placement-toggle")).toHaveAttribute(
      "data-selected",
      "this_device",
    );
    await expect(page.getByTestId("settings-location-line-text")).toHaveText(
      "Running on this device, which isn't ready",
    );
    await expect(page.getByTestId("readiness-credential")).toContainText("Missing");
    await expect(page.getByTestId("readiness-credential")).toContainText("OPENROUTER_API_KEY");
    await page.getByTestId("readiness-computer").getByRole("button").click();
    await expect(page.getByTestId("settings-computer")).toBeVisible();

    await page.getByTestId("settings-nav-location").click();
    await typeInto(page, "device-name", "Kitchen laptop");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("setting-device-name")).toContainText("Kitchen laptop");
  });

  test("Always-on machine: pairs with a code, explains refusals, checks and forgets", async ({
    page,
  }) => {
    await openApp(page, "mockRemote=no_machine");
    await openSettings(page, "machine");
    await typeInto(page, "machine-url", "https://vm-1.tailnet-name.ts.net/app");
    await typeInto(page, "machine-code", "abcd");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-url-problem")).toContainText("without a path");
    await expect(page.getByTestId("machine-code-problem")).toHaveText("Enter all 8 characters.");

    await typeInto(page, "machine-url", "vm-2.tailnet-name.ts.net");
    await typeInto(page, "machine-code", "xxxxxxxx");
    await expect(page.getByTestId("machine-code")).toHaveValue("XXXX-XXXX");
    await expect(page.getByTestId("machine-name")).toHaveAttribute("placeholder", "vm-2");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-pair-error")).toHaveText(
      "The always-on machine didn't accept that code: it's wrong, expired or already used. Get a new one on the machine.",
    );

    await typeInto(page, "machine-url", "https://offline.tailnet-name.ts.net");
    await typeInto(page, "machine-code", "ABCD2345");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-pair-error")).toContainText(
      "The always-on machine didn't answer.",
    );

    await typeInto(page, "machine-url", "vm-2.tailnet-name.ts.net");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-status-name")).toHaveText("vm-2");
    await expect(page.getByTestId("machine-reachable")).toHaveText("Reachable");
    await expect(page.getByTestId("machine-agent")).toHaveText("Running on this device");
    await expect(page.getByTestId("readiness-machine")).toContainText("Not on this machine");
    await expect(page.getByTestId("machine-open")).toHaveAttribute(
      "href",
      "https://vm-2.tailnet-name.ts.net",
    );
    await page.getByTestId("machine-check").click();
    await expect(page.getByTestId("machine-status")).toContainText("checked just now");

    // Now the toggle can hand the agent over.
    await page.keyboard.press("Escape");
    await openPanel(page);
    await expect(page.getByTestId("placement-toggle-always_on_machine")).toBeEnabled();

    await openSettings(page, "machine");
    await page.getByTestId("machine-forget").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("machine-not-paired")).toContainText("vm-2");
    await expect(page.getByTestId("machine-url")).toHaveValue("https://vm-2.tailnet-name.ts.net");
  });

  test("Sync: the token is write-only, and sync can be turned off", async ({ page }) => {
    await openApp(page, "mockRemote=ready");
    await openSettings(page, "sync");
    await expect(page.getByTestId("sync-state")).toHaveText("Up to date");
    await expect(page.getByTestId("sync-token")).toHaveValue("");
    await expect(page.getByTestId("sync-token-saved")).toHaveText("Saved");
    await expect(page.getByTestId("sync-save")).toBeDisabled();
    await typeInto(page, "sync-vault", "my vault");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sync-vault-problem")).toHaveText(
      "Use 1–64 letters, digits, _ or -.",
    );
    await typeInto(page, "sync-vault", "vault_2");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sync-saved")).toBeVisible();
    await expect(page.getByTestId("sync-token")).toHaveValue("");

    await page.getByTestId("sync-off").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("sync-state")).toHaveText("Off");
    await expect(page.getByTestId("sync-token-saved")).toHaveCount(0);
    await expect(page.getByTestId("sync-save")).toHaveText("Turn on sync");
  });

  test("Devices: a code with its countdown and address, and revoking a device", async ({
    page,
  }) => {
    await openApp(page, "mockRemote=host");
    await openSettings(page, "devices");
    await expect(page.getByTestId("device-row")).toHaveCount(1);
    await typeInto(page, "pairing-code-name", "Phone");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pairing-code")).toHaveText(
      /^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/,
    );
    await expect(page.getByTestId("pairing-code-expiry")).toHaveText(
      /^Expires in (5:00|4:[0-5]\d)$/,
    );
    await expect(page.getByTestId("pairing-code-url")).toHaveText(
      "https://vm-1.tailnet-name.ts.net",
    );
    await page.getByTestId("pairing-code-done").click();

    await page.getByTestId("device-revoke").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("Revoke Safari on iPad?");
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("devices-empty")).toBeVisible();
  });

  test("Devices: without remote hosts, a code points to Remote access", async ({ page }) => {
    await openApp(page, "mockRemote=ready");
    await openSettings(page, "devices");
    await page.getByTestId("pairing-code-create").click();
    await expect(page.getByTestId("pairing-code-no-url")).toBeVisible();
    await page.getByTestId("pairing-code-no-url").getByRole("button").click();
    await expect(page.getByTestId("settings-remote")).toBeVisible();
  });

  test("Remote access: add and remove the names this daemon answers to", async ({ page }) => {
    await openApp(page, "mockRemote=ready");
    await openSettings(page, "remote");
    await expect(page.getByTestId("remote-empty")).toBeVisible();
    await typeInto(page, "remote-host-input", "100.64.0.1");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("remote-host-problem")).toContainText("no IP address");
    await typeInto(page, "remote-host-input", "https://Laptop.tailnet-name.ts.net/");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("remote-host")).toHaveText(["laptop.tailnet-name.ts.net"]);
    await expect(page.getByTestId("remote-host-input")).toHaveValue("");
    await typeInto(page, "remote-host-input", "laptop.tailnet-name.ts.net");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("remote-host-problem")).toHaveText("It's already in the list.");
    await page.getByTestId("remote-host-remove").click();
    await expect(page.getByTestId("remote-empty")).toBeVisible();
  });
});

test.describe("the pairing screen", () => {
  test("a remote browser pairs with a code, and goes back to pairing once revoked", async ({
    page,
  }) => {
    // A code from an already paired device (here, this browser's normal mock page).
    await openApp(page, "mockRemote=host");
    await openSettings(page, "devices");
    await page.getByTestId("pairing-code-create").click();
    const code = await page.getByTestId("pairing-code").innerText();

    await page.goto("/?mock=1&mockAuth=pairing&mockRemote=host");
    await expect(page.getByTestId("pairing-screen")).toBeVisible();
    await expect(page.getByTestId("pairing-code-input")).toBeFocused();
    await expect(page.getByTestId("pairing-name")).not.toHaveValue("");
    await page.keyboard.type("zzzz9999");
    await expect(page.getByTestId("pairing-code-input")).toHaveValue("ZZZZ-9999");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("pairing-error")).toHaveText(
      "That code didn't work: it's wrong, expired or already used. Get a new one and try again.",
    );

    await typeInto(page, "pairing-code-input", code.toLowerCase().replace("-", " "));
    await expect(page.getByTestId("pairing-code-input")).toHaveValue(code);
    await typeInto(page, "pairing-name", "Test browser");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("note-title")).toBeVisible({ timeout: 15_000 });

    await openSettings(page, "devices");
    const me = page.getByTestId("device-row").filter({ has: page.getByTestId("device-current") });
    await expect(me.getByTestId("device-name")).toHaveText("Test browser");
    await me.getByTestId("device-revoke").click();
    await expect(page.getByTestId("confirm-dialog")).toContainText("Revoke this browser?");
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("pairing-screen")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("This browser was signed out");

    // Its old page state is gone for good: a reload asks to pair again.
    await page.reload();
    await expect(page.getByTestId("pairing-screen")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pair this browser");
  });
});
