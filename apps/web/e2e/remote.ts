import type { AgentStatusResponse } from "@ddl/core";
import { type Daemon, type DaemonSpec, expect, type Locator, type Page } from "./fixtures";

/**
 * The agent anywhere, set up the way users do it, with real daemons: devices sync one vault on the
 * harness's sync service, a second daemon plays the always-on machine, and this device pairs with
 * it through a code the machine issues (the steps Settings takes, here through the API).
 */
export const MACHINE = "vm-e2e";

/** The always-on machine: synced, placement `always_on_host`, no web app. */
export function machineSpec(sync: DaemonSpec["sync"]): DaemonSpec {
  return { device: MACHINE, sync, config: { agent: { placement: "always_on_host" } }, web: false };
}

/** A pairing code the machine issues (what its `pair` command prints). */
export async function machineCode(machine: Daemon): Promise<string> {
  const issued = await machine.api<{ code: string }>("POST", "/api/pairing-codes", {});
  expect(issued.status).toBe(201);
  return issued.body.code;
}

export async function pairWithMachine(device: Daemon, machine: Daemon): Promise<void> {
  const code = await machineCode(machine);
  const paired = await device.api("POST", "/api/machine/pair", {
    url: machine.url,
    code,
    name: MACHINE,
  });
  expect(paired.status).toBe(200);
}

export async function agentStatus(device: Daemon): Promise<AgentStatusResponse> {
  return (await device.api<AgentStatusResponse>("GET", "/api/agent/status")).body;
}

/** Waits until this device runs the agent (a device that just synced takes it over in seconds). */
export async function runsHere(device: Daemon): Promise<void> {
  await expect
    .poll(async () => (await agentStatus(device)).placement?.runsOn?.thisDevice, {
      timeout: 20_000,
    })
    .toBe(true);
}

/** Hands this device's agent to the machine and waits until the relay is up. */
export async function relayToMachine(device: Daemon): Promise<void> {
  expect(
    (await device.api("PATCH", "/api/device", { placement: "always_on_machine" })).status,
  ).toBe(200);
  await expect
    .poll(async () => (await agentStatus(device)).placement?.relay, { timeout: 20_000 })
    .toBe("connected");
}

/** The agent panel stays open across reloads: open it only when it's closed. */
export async function openPanel(page: Page): Promise<void> {
  if ((await page.getByTestId("right-panel").count()) === 0) {
    await page.keyboard.press("ControlOrMeta+Shift+A");
  }
  await expect(page.getByTestId("agent-location")).toBeVisible();
}

export async function openSettings(page: Page, section: string): Promise<void> {
  if ((await page.getByTestId("settings-modal").count()) === 0) {
    await page.keyboard.press("ControlOrMeta+,");
  }
  await page.getByTestId(`settings-nav-${section}`).click();
  await expect(page.getByTestId(`settings-${section}`)).toBeVisible();
}

/** Types into a field with the real keyboard, replacing what's there. */
export async function typeInto(page: Page, testId: string, text: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.keyboard.press("ControlOrMeta+A");
  if (text) await page.keyboard.type(text, { delay: 5 });
  else await page.keyboard.press("Backspace");
}

/** Hovers `target` with the real mouse and returns the tooltip that opens. */
export async function tooltipOf(page: Page, target: Locator): Promise<Locator> {
  const box = await target.boundingBox();
  if (!box) throw new Error("target isn't visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  const tip = page.locator("#ddl-tooltip");
  await expect(tip).toHaveClass(/\bis-visible\b/);
  return tip.locator(".tooltip-text");
}

export function locationLine(page: Page): Locator {
  return page.getByTestId("agent-location-line-text");
}
