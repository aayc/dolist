import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComputerPermissionError,
  ExecutionError,
  ProtectedAppError,
  StaleElementError,
} from "../../errors";
import { HelperClient } from "./client";
import { HelperAppController } from "./controller";

const FAKE_HELPER = fileURLToPath(new URL("./testing/fake-computer-helper.ts", import.meta.url));
const SPAWN_TIMEOUT_MS = 30_000;
const controllers: HelperAppController[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((c) => c.dispose()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function controller(flags: string[] = []): HelperAppController {
  const apps = new HelperAppController({
    client: new HelperClient({ command: process.execPath, args: [FAKE_HELPER, "serve", ...flags] }),
    hostApp: async () => ({
      name: "Terminal",
      path: "/System/Applications/Utilities/Terminal.app",
    }),
  });
  controllers.push(apps);
  return apps;
}

describe("HelperAppController", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("reads apps, windows and screenshots as typed values", async () => {
    const apps = controller();
    const running = await apps.runningApps();
    expect(running[0]).toEqual({
      name: "Grok Bot",
      bundleId: "com.example.grokbot",
      pid: 501,
      active: true,
      hidden: false,
    });
    const snapshot = await apps.snapshot(501);
    expect(snapshot.app.name).toBe("Grok Bot");
    expect(snapshot.window?.title).toBe("Grok");
    expect(snapshot.text).toContain('AXTextArea name="Ask anything" settable');
    expect(snapshot.elements.find((e) => e.name === "Send")).toMatchObject({
      role: "AXButton",
      actions: ["press"],
    });
    const shot = await apps.screenshot(501);
    expect(shot).toMatchObject({ width: 900, height: 700, scale: 1, origin: { x: 100, y: 80 } });
  });

  it("turns a missing permission into help that names the host app", async () => {
    const noAccessibility = controller(["--fake-no-accessibility"]);
    const error = await noAccessibility.snapshot(501).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ComputerPermissionError);
    const message = (error as Error).message;
    expect(message).toContain("“Terminal”");
    expect(message).toContain("Privacy & Security → Accessibility");
    expect(message).toContain("Settings → Computer Use");
    expect(message).not.toContain("Screen Recording");

    const noScreen = controller(["--fake-no-screen"]);
    const shot = await noScreen.screenshot(501).catch((e: unknown) => e);
    expect(shot).toBeInstanceOf(ComputerPermissionError);
    expect((shot as Error).message).toContain("Screen & System Audio Recording");
    expect((shot as Error).message).toContain("quit and reopen it");
    expect(await noScreen.permissions()).toEqual({ accessibility: true, screenRecording: false });
  });

  it("refuses protected apps with a clear message", async () => {
    const apps = controller();
    const error = await apps.snapshot(504).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtectedAppError);
    expect((error as Error).message).toMatch(/off-limits to agents/);
    await expect(apps.openApp({ name: "Okta Verify" })).rejects.toBeInstanceOf(ProtectedAppError);
  });

  it("tells the model to read the app again when an element is stale", async () => {
    const apps = controller();
    const first = await apps.snapshot(501);
    const send = first.elements.find((e) => e.name === "Send")!;
    await apps.snapshot(501);
    const error = await apps
      .press(501, { snapshotId: first.snapshotId, elementId: send.id })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StaleElementError);
    expect((error as Error).message).toMatch(/call computer_app_state again/);
  });

  it("acts on the latest snapshot and reports when it went stale", async () => {
    const apps = controller();
    const snapshot = await apps.snapshot(501);
    const prompt = snapshot.elements.find((e) => e.name === "Ask anything")!;
    const send = snapshot.elements.find((e) => e.name === "Send")!;
    const target = (id: string) => ({ snapshotId: snapshot.snapshotId, elementId: id });
    expect(await apps.setValue(501, target(prompt.id), "tides")).toEqual({
      stale: false,
      value: "tides",
    });
    expect(await apps.press(501, target(send.id))).toEqual({ stale: true });
    expect((await apps.snapshot(501)).text).toContain("Grok: Here's what I found about tides.");
  });

  it("launches apps in the background and explains ambiguous names", async () => {
    const apps = controller();
    const notes = await apps.openApp({ name: "notes" });
    expect(notes).toMatchObject({ name: "Notes", launched: true });
    expect((await apps.runningApps()).some((app) => app.pid === notes.pid)).toBe(true);
    expect(await apps.openApp({ bundleId: "com.example.grokbot" })).toMatchObject({
      pid: 501,
      launched: false,
    });
    const error = await apps.openApp({ name: "grok" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecutionError);
    expect((error as Error).message).toContain("Grok Bot, Grok (Next)");
  });

  it("caches the installed apps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ddl-helper-log-"));
    dirs.push(dir);
    const log = path.join(dir, "requests.jsonl");
    const apps = controller([`--fake-log=${log}`]);
    const [a, b] = await Promise.all([apps.installedApps(), apps.installedApps()]);
    expect(a).toBe(b);
    expect(await apps.installedApps()).toBe(a);
    expect(a.map((app) => app.name)).toContain("Microsoft Teams");
    const requests = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(requests.filter((r) => r.method === "installedApps")).toHaveLength(1);
  });
});
