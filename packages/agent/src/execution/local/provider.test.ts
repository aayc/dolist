import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "./jxa";
import { LocalExecutionProvider } from "./provider";
import { workspaceDirName } from "./workspace";

const CHROME = { executablePath: "/opt/chrome/chrome", source: "chrome" as const };
const FAKE_HELPER = fileURLToPath(
  new URL("./app-control/testing/fake-computer-helper.ts", import.meta.url),
);

/** `ps`, `plutil` and the JXA permission probe, scripted (nothing real is queried). */
function scripted(permissions: { accessibility: boolean; screenRecording: boolean | null }) {
  const calls: string[] = [];
  const runner: CommandRunner = async (file) => {
    calls.push(file);
    if (file === "ps") {
      return {
        stdout: [
          `${process.pid} 42 /opt/homebrew/bin/node`,
          "42 1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
        ].join("\n"),
        stderr: "",
      };
    }
    if (file === "plutil") return { stdout: "com.apple.Terminal\n", stderr: "" };
    if (file === "osascript") return { stdout: JSON.stringify(permissions), stderr: "" };
    throw new Error(`unexpected ${file}`);
  };
  return { runner, calls };
}

const TERMINAL = {
  name: "Terminal",
  path: "/System/Applications/Utilities/Terminal.app",
  bundleId: "com.apple.Terminal",
};

describe("workspaceDirName", () => {
  it("keeps safe keys and disambiguates the rest", () => {
    expect(workspaceDirName("thr_k3j9x0q2m1ab")).toBe("thr_k3j9x0q2m1ab");
    expect(workspaceDirName("a/b")).toMatch(/^a-b-[0-9a-f]{8}$/);
    expect(workspaceDirName("a:b")).toMatch(/^a-b-[0-9a-f]{8}$/);
    expect(workspaceDirName("a/b")).not.toBe(workspaceDirName("a:b"));
    expect(workspaceDirName("Thread")).not.toBe(workspaceDirName("thread"));
    expect(workspaceDirName("../../etc")).toMatch(/^etc-[0-9a-f]{8}$/);
    expect(workspaceDirName("..")).toMatch(/^workspace-[0-9a-f]{8}$/);
    expect(workspaceDirName("")).toMatch(/^workspace-[0-9a-f]{8}$/);
    expect(workspaceDirName("x".repeat(300)).length).toBeLessThanOrEqual(89);
  });
});

describe("LocalExecutionProvider", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ddl-exec-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("renders drawings only with a browser and the built render page", async () => {
    const page = join(home, "drawing-renderer");
    const without = [
      new LocalExecutionProvider({ kind: "local", home }, { resolveBrowser: () => CHROME }),
      new LocalExecutionProvider(
        { kind: "local", home, drawingRenderer: page },
        { resolveBrowser: () => undefined },
      ),
    ];
    for (const provider of without) expect(provider.drawings).toBeUndefined();
    const provider = new LocalExecutionProvider(
      { kind: "local", home, drawingRenderer: page },
      { resolveBrowser: () => CHROME },
    );
    const renderer = provider.drawings;
    expect(renderer).toBeDefined();
    expect(provider.drawings).toBe(renderer);
    await provider.dispose();
    expect(provider.drawings).toBeUndefined();
  });

  it("prepares owner-only workspaces under <home>/workspaces", async () => {
    const provider = new LocalExecutionProvider(
      { kind: "local", home },
      { resolveBrowser: () => undefined },
    );
    const workspace = await provider.prepareWorkspace("thr_abc");
    expect(workspace).toEqual({ key: "thr_abc", dir: join(home, "workspaces", "thr_abc") });
    expect((await stat(workspace.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, "workspaces"))).mode & 0o777).toBe(0o700);
    const again = await provider.prepareWorkspace("thr_abc");
    expect(again.dir).toBe(workspace.dir);
    const odd = await provider.prepareWorkspace("../escape");
    expect(odd.dir.startsWith(join(home, "workspaces"))).toBe(true);
  });

  it("derives capabilities from the machine and config", () => {
    const mac = new LocalExecutionProvider(
      { kind: "local", home },
      { platform: "darwin", resolveBrowser: () => CHROME },
    );
    expect(mac.capabilities).toEqual({ shell: true, browser: true, computer: true });
    expect(mac.browserProfileDir).toBe(join(home, "browser-profile"));

    const disabled = new LocalExecutionProvider(
      { kind: "local", home, computer: { enabled: false } },
      { platform: "darwin", resolveBrowser: () => undefined },
    );
    expect(disabled.capabilities).toEqual({ shell: true, browser: false, computer: false });
    expect(disabled.browser).toBeUndefined();
    expect(disabled.computer).toBeUndefined();

    const linux = new LocalExecutionProvider(
      { kind: "local", home },
      { platform: "linux", resolveBrowser: () => CHROME },
    );
    expect(linux.capabilities.computer).toBe(false);
  });

  it("passes browser config to discovery and creates controllers lazily, once", async () => {
    const seen: unknown[] = [];
    const provider = new LocalExecutionProvider(
      { kind: "local", home, browser: { channel: "msedge", headless: false } },
      {
        platform: "darwin",
        resolveBrowser: (config) => {
          seen.push(config);
          return CHROME;
        },
      },
    );
    expect(seen).toEqual([{ channel: "msedge", headless: false }]);
    const browser = provider.browser;
    expect(browser).toBeDefined();
    expect(provider.browser).toBe(browser);
    expect(browser?.has("thread")).toBe(false);
    expect(provider.computer?.platform).toBe("macos");
    expect(provider.computer).toBe(provider.computer);

    await provider.dispose();
    await provider.dispose();
    expect(provider.browser).toBeUndefined();
    await expect(browser?.session("thread")).rejects.toThrow(/disposed/);
  });

  it("runs shell commands", async () => {
    const provider = new LocalExecutionProvider(
      { kind: "local", home },
      { resolveBrowser: () => undefined },
    );
    const workspace = await provider.prepareWorkspace("shell");
    const result = await provider.shell.exec("echo ok", { cwd: workspace.dir });
    expect(result).toMatchObject({ exitCode: 0, output: expect.stringContaining("ok") });
    await provider.dispose();
  });

  describe("computer access", { timeout: 30_000 }, () => {
    it("reports the helper's permissions, app control and the host app", async () => {
      const { runner, calls } = scripted({ accessibility: false, screenRecording: false });
      const provider = new LocalExecutionProvider(
        { kind: "local", home, computer: { enabled: true, helper: process.execPath } },
        {
          platform: "darwin",
          resolveBrowser: () => undefined,
          runner,
          helperArgs: [FAKE_HELPER, "serve", "--fake-no-screen"],
        },
      );
      try {
        expect(provider.computerHelper).toBe(process.execPath);
        expect(provider.apps).toBe(provider.apps);
        expect(await provider.computerAccess()).toEqual({
          accessibility: true,
          screenRecording: false,
          appControl: true,
          hostApp: TERMINAL,
        });
        // The helper answered for the permissions; the JXA probe wasn't needed.
        expect(calls).not.toContain("osascript");
        await provider.computerAccess();
        expect(calls.filter((c) => c === "ps")).toHaveLength(1);
      } finally {
        await provider.dispose();
      }
      expect(provider.apps).toBeUndefined();
      expect(await provider.computerAccess()).toBeUndefined();
    });

    it("falls back to the screen-level probe without a helper", async () => {
      const { runner } = scripted({ accessibility: true, screenRecording: null });
      const provider = new LocalExecutionProvider(
        { kind: "local", home },
        { platform: "darwin", resolveBrowser: () => undefined, runner },
      );
      expect(provider.apps).toBeUndefined();
      expect(await provider.computerAccess()).toEqual({
        accessibility: true,
        screenRecording: false,
        appControl: false,
        hostApp: TERMINAL,
      });
      await provider.dispose();
    });

    it("drops app control when the helper can't start, and has no access where computer use is off", async () => {
      const { runner } = scripted({ accessibility: true, screenRecording: true });
      const broken = new LocalExecutionProvider(
        { kind: "local", home, computer: { enabled: true, helper: "/nonexistent/ddl-computer" } },
        { platform: "darwin", resolveBrowser: () => undefined, runner },
      );
      expect(await broken.computerAccess()).toMatchObject({
        appControl: false,
        accessibility: true,
      });
      expect(broken.apps).toBeUndefined();
      await broken.dispose();

      const linux = new LocalExecutionProvider(
        { kind: "local", home, computer: { enabled: true, helper: process.execPath } },
        { platform: "linux", resolveBrowser: () => undefined, runner },
      );
      expect(linux.computerHelper).toBeUndefined();
      expect(linux.apps).toBeUndefined();
      expect(await linux.computerAccess()).toBeUndefined();
    });
  });
});
