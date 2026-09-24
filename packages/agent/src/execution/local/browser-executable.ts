import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export type BrowserChannel = "chrome" | "chromium" | "msedge";

export interface ResolvedBrowser {
  executablePath: string;
  /** Where the executable came from (for logs/status). */
  source: "config" | BrowserChannel | "playwright-chromium";
}

export interface ResolveBrowserOptions {
  channel?: BrowserChannel;
  executablePath?: string;
}

export interface ResolveBrowserDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
  /** Playwright's managed Chromium location (may not be installed). */
  playwrightChromium: () => string | undefined;
}

const defaultDeps: ResolveBrowserDeps = {
  platform: process.platform,
  env: process.env,
  home: homedir(),
  exists: existsSync,
  playwrightChromium: () => {
    try {
      // Only reached when no installed browser was found; a static import would load
      // Playwright (~150 ms) on every daemon start.
      const { chromium } = createRequire(import.meta.url)(
        "playwright-core",
      ) as typeof import("playwright-core");
      return chromium.executablePath();
    } catch {
      return undefined;
    }
  },
};

function macApp(home: string, app: string, binary: string): string[] {
  const inner = join(`${app}.app`, "Contents", "MacOS", binary);
  return [join("/Applications", inner), join(home, "Applications", inner)];
}

function windowsApp(env: NodeJS.ProcessEnv, relative: string): string[] {
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env["PROGRAMFILES(X86)"]];
  return roots.filter((root): root is string => Boolean(root)).map((root) => join(root, relative));
}

/** Well-known install locations per channel (same places Playwright's `channel` option looks). */
export function channelCandidates(channel: BrowserChannel, deps: ResolveBrowserDeps): string[] {
  const { platform, home, env } = deps;
  switch (channel) {
    case "chrome":
      if (platform === "darwin") return macApp(home, "Google Chrome", "Google Chrome");
      if (platform === "win32") return windowsApp(env, "Google\\Chrome\\Application\\chrome.exe");
      return [
        "/opt/google/chrome/chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
      ];
    case "msedge":
      if (platform === "darwin") return macApp(home, "Microsoft Edge", "Microsoft Edge");
      if (platform === "win32") return windowsApp(env, "Microsoft\\Edge\\Application\\msedge.exe");
      return ["/opt/microsoft/msedge/msedge"];
    case "chromium":
      if (platform === "darwin") return macApp(home, "Chromium", "Chromium");
      if (platform === "win32") return [];
      return ["/usr/bin/chromium", "/usr/bin/chromium-browser"];
  }
}

/**
 * Picks the browser binary: an explicit `executablePath`, then the requested channel (installed
 * Google Chrome by default), then Playwright's managed Chromium. `undefined` = no browser.
 */
export function resolveBrowserExecutable(
  options: ResolveBrowserOptions = {},
  deps: ResolveBrowserDeps = defaultDeps,
): ResolvedBrowser | undefined {
  if (options.executablePath && deps.exists(options.executablePath)) {
    return { executablePath: options.executablePath, source: "config" };
  }
  const channel = options.channel ?? "chrome";
  for (const candidate of channelCandidates(channel, deps)) {
    if (deps.exists(candidate)) return { executablePath: candidate, source: channel };
  }
  const bundled = deps.playwrightChromium();
  if (bundled && deps.exists(bundled)) {
    return { executablePath: bundled, source: "playwright-chromium" };
  }
  return undefined;
}
