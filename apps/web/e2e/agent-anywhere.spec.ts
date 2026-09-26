import { expect, type Page, syncVault, test } from "./fixtures";
import { openApp } from "./helpers";
import {
  agentStatus,
  locationLine as line,
  MACHINE,
  machineCode,
  machineSpec,
  openPanel,
  openSettings,
  pairWithMachine,
  relayToMachine,
  runsHere,
  tooltipOf,
  typeInto,
} from "./remote";

/**
 * Where the agent runs, the always-on machine, sync, devices, remote access and the pairing
 * screen, against real daemons (e2e/remote.ts): this device's daemon, a second one as the
 * always-on machine, another device, all syncing on the harness's sync service. Real keyboard and
 * mouse throughout.
 */

/** Records every text the location line shows (a handover's note can be brief). */
async function recordLine(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __lineSeen: string[] }).__lineSeen = seen;
    const scan = () => {
      const text = document.querySelector("[data-testid='agent-location-line-text']")?.textContent;
      if (text && seen.at(-1) !== text) seen.push(text);
    };
    new MutationObserver(scan).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    scan();
  });
  return () => page.evaluate(() => (window as unknown as { __lineSeen: string[] }).__lineSeen);
}

test.describe("the orchestrator toggle", () => {
  test("hands the agent to the machine and takes it back, showing each handover", async ({
    page,
    launch,
  }) => {
    const sync = await syncVault();
    const machine = await launch(machineSpec(sync));
    const device = await launch({ sync });
    await pairWithMachine(device, machine);
    await runsHere(device);
    await openApp(page, `${device.url}/?debug=1`);
    await openPanel(page);
    const toggle = page.getByTestId("placement-toggle");
    await expect(toggle).toHaveAttribute("data-selected", "this_device");
    await expect(line(page)).toHaveText("Running on this device");
    const seen = await recordLine(page);

    await page.getByTestId("placement-toggle-always_on_machine").click();
    await expect(toggle).toHaveAttribute("data-selected", "always_on_machine");
    await expect(line(page)).toHaveText(`Running on ${MACHINE}`, { timeout: 20_000 });
    expect(await seen()).toContain(`Handing the agent to ${MACHINE}…`);
    expect(await (await tooltipOf(page, line(page))).textContent()).toBe(
      `${MACHINE} is the always-on machine`,
    );

    await page.getByTestId("placement-toggle-this_device").click();
    await expect(line(page)).toHaveText("Running on this device", { timeout: 20_000 });
    expect(await seen()).toContain(`Taking over from ${MACHINE}…`);
    await expect(page.getByTestId("agent-banner")).toHaveCount(0);
  });

  test("is held on this device until sync and a machine are set up, and says why", async ({
    page,
  }) => {
    const sync = await syncVault();
    await openApp(page);
    await openPanel(page);
    const toggle = page.getByTestId("placement-toggle");
    await expect(toggle).toHaveAttribute("data-disabled", "true");
    await expect(page.getByTestId("placement-toggle-always_on_machine")).toBeDisabled();
    await expect(await tooltipOf(page, toggle)).toHaveText("This device doesn't sync");
    await expect(line(page)).toHaveText("Running on this device");
    await openSettings(page, "location");
    await expect(page.getByTestId("readiness-here").getByTestId(/^readiness-/)).toHaveCount(5);
    await expect(page.getByTestId("readiness-credential")).toContainText("Present");
    await page.keyboard.press("Escape");

    await page.getByTestId("agent-location-line-action").click();
    await expect(page.getByTestId("settings-sync")).toBeVisible();
    await expect(page.getByTestId("sync-state")).toHaveText("Off");
    await typeInto(page, "sync-url", sync.url);
    await typeInto(page, "sync-vault", sync.vault);
    await typeInto(page, "sync-token", sync.token);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sync-saved")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("sync-token")).toHaveValue("");
    await expect(page.getByTestId("sync-token-saved")).toBeVisible();
    await expect(page.getByTestId("sync-state")).toHaveText("Up to date", { timeout: 20_000 });
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

  test("relayed to the machine, this device acts on its agent", async ({ page, launch }) => {
    const sync = await syncVault();
    const machine = await launch(machineSpec(sync));
    const device = await launch({ sync });
    await pairWithMachine(device, machine);
    await relayToMachine(device);
    await openApp(page, `${device.url}/?debug=1`);
    await openPanel(page);
    await expect(page.getByTestId("agent-location")).toHaveAttribute("data-relay", "connected");
    await expect(line(page)).toHaveText(`Running on ${MACHINE}`);
    await expect(page.getByTestId("agent-banner")).toHaveCount(0);
    await expect(page.getByTestId("status-agent").locator("span").first()).toHaveText(
      `Agent on ${MACHINE}`,
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
  });

  test("when the machine goes away, this device shows its work read-only until it's back", async ({
    page,
    launch,
  }) => {
    const sync = await syncVault();
    const machine = await launch(machineSpec(sync));
    const device = await launch({ sync });
    await pairWithMachine(device, machine);
    await relayToMachine(device);
    await openApp(page, `${device.url}/?debug=1`);
    await openPanel(page);
    const location = page.getByTestId("agent-location");
    await expect(location).toHaveAttribute("data-relay", "connected");
    await page.getByTestId("inbox-orchestrator").click();
    await expect(page.getByTestId("composer-input")).toBeEnabled();

    await machine.stop();
    await expect(page.getByTestId("agent-banner")).toContainText(
      "The always-on machine can't be reached — showing the last synced state",
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("composer-input")).toBeDisabled();
    await expect(page.getByTestId("composer-input")).toHaveAttribute(
      "placeholder",
      "The always-on machine can't be reached",
    );
    await page.getByTestId("thread-back").click();
    await expect(location).toHaveAttribute("data-relay", "unreachable");
    await expect(line(page)).toHaveText(`${MACHINE} can't be reached`);
    await expect(page.getByTestId("status-agent").locator("span").first()).toHaveText(
      "Agent unreachable",
    );

    await machine.start();
    await expect(location).toHaveAttribute("data-relay", "connected", { timeout: 20_000 });
    await expect(page.getByTestId("agent-banner")).toHaveCount(0);
  });

  test("offers running here when the machine can't be reached", async ({ page, launch }) => {
    const sync = await syncVault();
    const machine = await launch(machineSpec(sync));
    const device = await launch({ sync });
    await pairWithMachine(device, machine);
    await relayToMachine(device);
    await openApp(page, `${device.url}/?debug=1`);
    await openPanel(page);
    await expect(line(page)).toHaveText(`Running on ${MACHINE}`);
    await machine.stop();
    await expect(line(page)).toHaveText(`${MACHINE} can't be reached`, { timeout: 20_000 });
    await page.getByTestId("agent-banner-run-here").click();
    await expect(line(page)).toHaveText("Running on this device", { timeout: 20_000 });
    await expect(page.getByTestId("placement-toggle")).toHaveAttribute(
      "data-selected",
      "this_device",
    );
    await expect(page.getByTestId("agent-banner")).toHaveCount(0);
  });

  test("says so when the machine no longer accepts this device, and pairs again", async ({
    page,
    launch,
  }) => {
    const sync = await syncVault();
    const machine = await launch(machineSpec(sync));
    const device = await launch({ sync });
    await pairWithMachine(device, machine);
    await relayToMachine(device);
    await openApp(page, `${device.url}/?debug=1`);
    await openPanel(page);
    await expect(line(page)).toHaveText(`Running on ${MACHINE}`);

    // Revoked on the machine.
    const listed = await machine.api<{ devices: Array<{ id: string }> }>("GET", "/api/devices");
    for (const { id } of listed.body.devices) await machine.api("DELETE", `/api/devices/${id}`);
    await expect(page.getByTestId("agent-banner")).toContainText(
      "The always-on machine no longer accepts this device — showing the last synced state",
      { timeout: 20_000 },
    );
    await expect(line(page)).toHaveText("The always-on machine no longer accepts this device");
    await page.getByTestId("agent-banner-pair").click();
    await page.getByTestId("machine-check").click();
    await expect(page.getByTestId("machine-status")).toContainText(
      "no longer accepts this device's credential",
    );
    await page.getByTestId("machine-pair-again").click();
    await expect(page.getByTestId("machine-url")).toHaveValue(machine.url);
    await expect(page.getByTestId("machine-name")).toHaveValue(MACHINE);
    await typeInto(page, "machine-code", await machineCode(machine));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-pair-form")).toHaveCount(0);
    await expect(page.getByTestId("machine-error")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(line(page)).toHaveText(`Running on ${MACHINE}`, { timeout: 20_000 });
    await expect(page.getByTestId("agent-banner")).toHaveCount(0);
  });

  test("says this is the always-on machine on the machine itself", async ({ page, launch }) => {
    const sync = await syncVault();
    const host = await launch({ ...machineSpec(sync), web: true });
    // A device paired with it: it's now the vault's always-on machine.
    await pairWithMachine(await launch({ sync, web: false }), host);
    await openApp(page, `${host.url}/?debug=1`);
    await openPanel(page);
    await expect(page.getByTestId("placement-host")).toHaveText("This is the always-on machine");
    await expect(page.getByTestId("placement-toggle")).toHaveCount(0);
    await expect(line(page)).toHaveText("Running here");
  });

  test("is read-only where an environment variable sets it", async ({ page, launch }) => {
    const sync = await syncVault();
    const machine = await launch(machineSpec(sync));
    const locked = await launch({
      env: {
        DDL_AGENT_PLACEMENT: "this_device",
        DDL_REMOTE_HOSTS: "laptop.tailnet-name.ts.net",
        DDL_SYNC_URL: sync.url,
        DDL_SYNC_VAULT: sync.vault,
        DDL_SYNC_TOKEN: sync.token,
      },
    });
    await pairWithMachine(locked, machine);
    await openApp(page, `${locked.url}/?debug=1`);
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
  test("the panel shows the synced state read-only, and actions say why", async ({
    page,
    launch,
  }) => {
    const sync = await syncVault();
    const laptop = await launch({ device: "Work laptop", sync, web: false });
    await runsHere(laptop);
    const device = await launch({ sync });
    // Its orchestrator's chat is synced like the rest of the vault.
    await expect
      .poll(() => device.read(".daily-do-list/threads/thr_orchestrator.json"), { timeout: 20_000 })
      .not.toBeNull();
    await expect
      .poll(async () => (await agentStatus(device)).placement?.runsOn?.name, { timeout: 20_000 })
      .toBe("Work laptop");
    await openApp(page, `${device.url}/?debug=1`);
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
  test.describe("without the model's key", () => {
    test.use({ daemonSpec: { agent: "live", noKey: true } });

    test("Agent location: the toggle, where it runs, and this device's readiness", async ({
      page,
    }) => {
      await openApp(page);
      await openSettings(page, "location");
      await expect(page.getByTestId("settings-placement-toggle")).toHaveAttribute(
        "data-selected",
        "this_device",
      );
      await expect(page.getByTestId("settings-location-line-text")).toHaveText(
        "Running on this device, which isn't ready",
      );
      await expect(page.getByTestId("readiness-here").getByTestId(/^readiness-/)).toHaveCount(5);
      await expect(page.getByTestId("readiness-credential")).toContainText("Missing");
      await expect(page.getByTestId("readiness-credential")).toContainText("OPENROUTER_API_KEY");

      await typeInto(page, "device-name", "Kitchen laptop");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("setting-device-name")).toContainText("Kitchen laptop");
    });
  });

  test("Always-on machine: pairs with a code, explains refusals, checks and forgets", async ({
    page,
    launch,
  }) => {
    const sync = await syncVault();
    const machine = await launch(machineSpec(sync));
    const device = await launch({ sync });
    await openApp(page, `${device.url}/?debug=1`);
    await openSettings(page, "machine");
    await typeInto(page, "machine-url", "https://vm-1.tailnet-name.ts.net/app");
    await typeInto(page, "machine-code", "abcd");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-url-problem")).toContainText("without a path");
    await expect(page.getByTestId("machine-code-problem")).toHaveText("Enter all 8 characters.");

    await typeInto(page, "machine-url", machine.url);
    await typeInto(page, "machine-code", "xxxxxxxx");
    await expect(page.getByTestId("machine-code")).toHaveValue("XXXX-XXXX");
    await typeInto(page, "machine-name", MACHINE);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-pair-error")).toHaveText(
      "The always-on machine didn't accept that code: it's wrong, expired or already used. Get a new one on the machine.",
    );

    // Nothing listens there.
    await typeInto(page, "machine-url", "http://127.0.0.1:9");
    await typeInto(page, "machine-code", "ABCD2345");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-pair-error")).toContainText(
      "The always-on machine didn't answer.",
    );

    await typeInto(page, "machine-url", machine.url);
    await typeInto(page, "machine-code", await machineCode(machine));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("machine-status-name")).toHaveText(MACHINE);
    await expect(page.getByTestId("machine-reachable")).toHaveText("Reachable");
    await expect(page.getByTestId("machine-version")).not.toHaveText("—");
    await expect(page.getByTestId("readiness-machine")).toBeVisible();
    await expect(page.getByTestId("machine-open")).toHaveAttribute("href", machine.url);
    await page.getByTestId("machine-check").click();
    await expect(page.getByTestId("machine-status")).toContainText("checked just now");

    // Now the toggle can hand the agent over.
    await page.keyboard.press("Escape");
    await openPanel(page);
    await expect(page.getByTestId("placement-toggle-always_on_machine")).toBeEnabled();

    await openSettings(page, "machine");
    await page.getByTestId("machine-forget").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("machine-not-paired")).toContainText(MACHINE);
    await expect(page.getByTestId("machine-url")).toHaveValue(machine.url);
  });

  test("Sync: the token is write-only, and sync can be turned off", async ({ page, launch }) => {
    const sync = await syncVault();
    const device = await launch({ sync });
    await openApp(page, `${device.url}/?debug=1`);
    await openSettings(page, "sync");
    await expect(page.getByTestId("sync-state")).toHaveText("Up to date", { timeout: 20_000 });
    await expect(page.getByTestId("sync-token")).toHaveValue("");
    await expect(page.getByTestId("sync-token-saved")).toHaveText("Saved");
    await expect(page.getByTestId("sync-save")).toBeDisabled();
    await typeInto(page, "sync-vault", "my vault");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sync-vault-problem")).toHaveText(
      "Use 1–64 letters, digits, _ or -.",
    );
    await typeInto(page, "sync-vault", sync.vault);
    await expect(page.getByTestId("sync-vault-problem")).toHaveCount(0);

    await page.getByTestId("sync-off").click();
    await page.getByTestId("confirm-accept").click();
    await expect(page.getByTestId("sync-state")).toHaveText("Off");
    await expect(page.getByTestId("sync-token-saved")).toHaveCount(0);
    await expect(page.getByTestId("sync-save")).toHaveText("Turn on sync");
  });

  test.describe("with a remote host", () => {
    test.use({ daemonSpec: { config: { remote: { hosts: ["vm-1.tailnet-name.ts.net"] } } } });

    test("Devices: a code with its countdown and address, a device pairs, and revoking it", async ({
      page,
      daemon,
    }) => {
      await openApp(page);
      await openSettings(page, "devices");
      await expect(page.getByTestId("devices-empty")).toBeVisible();
      await typeInto(page, "pairing-code-name", "Phone");
      await page.keyboard.press("Enter");
      const code = page.getByTestId("pairing-code");
      await expect(code).toHaveText(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
      await expect(page.getByTestId("pairing-code-expiry")).toHaveText(
        /^Expires in (5:00|4:[0-5]\d)$/,
      );
      await expect(page.getByTestId("pairing-code-url")).toHaveText(
        "https://vm-1.tailnet-name.ts.net",
      );

      // The new device (a native app) exchanges the code for its token.
      const paired = await fetch(`${daemon.url}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: await code.innerText(), name: "Ignored", kind: "app" }),
      });
      expect(paired.status).toBe(201);
      const { token } = (await paired.json()) as { token: string };
      await expect(page.getByTestId("device-paired")).toHaveText("Paired: Phone.");
      const row = page.getByTestId("device-row").filter({ hasText: "Phone" });
      await expect(row).toContainText("App");

      await row.getByTestId("device-revoke").click();
      await expect(page.getByTestId("confirm-dialog")).toContainText("Revoke Phone?");
      await page.getByTestId("confirm-accept").click();
      await expect(page.getByTestId("devices-empty")).toBeVisible();
      const refused = await fetch(`${daemon.url}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(refused.status).toBe(401);
    });
  });

  test("Devices: without remote hosts, a code points to Remote access", async ({ page }) => {
    await openApp(page);
    await openSettings(page, "devices");
    await page.getByTestId("pairing-code-create").click();
    await expect(page.getByTestId("pairing-code-no-url")).toBeVisible();
    await page.getByTestId("pairing-code-no-url").getByRole("button").click();
    await expect(page.getByTestId("settings-remote")).toBeVisible();
  });

  test("Remote access: add and remove the names this daemon answers to", async ({ page }) => {
    await openApp(page);
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

test.describe("a browser on a remote host", () => {
  test("gets the pairing screen, never the token", async ({ playwright, daemon }) => {
    const host = `laptop.e2e.example:${daemon.port}`;
    expect((await daemon.api("PATCH", "/api/device", { remoteHosts: [host] })).status).toBe(200);
    // Its own browser, which resolves the remote host's name to this machine.
    const browser = await playwright.chromium.launch({
      ...(test.info().project.use.channel ? { channel: test.info().project.use.channel } : {}),
      args: ["--host-resolver-rules=MAP laptop.e2e.example 127.0.0.1"],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      await page.goto(`http://${host}/`);
      await expect(page.getByTestId("pairing-screen")).toBeVisible();
      expect(await page.locator('meta[name="ddl-token"]').count()).toBe(0);
      await expect(page.locator('meta[name="ddl-auth"]')).toHaveAttribute("content", "pairing");
      await expect(page.getByTestId("pairing-code-input")).toBeFocused();
      await expect(page.getByTestId("pairing-name")).not.toHaveValue("");
      await page.keyboard.type("zzzz9999");
      await expect(page.getByTestId("pairing-code-input")).toHaveValue("ZZZZ-9999");
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
