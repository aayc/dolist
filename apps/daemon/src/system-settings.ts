import { execFile } from "node:child_process";
import type { ComputerPermissionPane } from "@ddl/core";

/**
 * System Settings deep links, tried in order until `open` accepts one: the pane itself (the macOS
 * 13+ address, then the newer extension one), then the Privacy & Security root.
 */
export const SYSTEM_SETTINGS_LINKS: Readonly<Record<ComputerPermissionPane, readonly string[]>> = {
  accessibility: [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility",
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
    "x-apple.systempreferences:com.apple.preference.security",
  ],
  screenRecording: [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture",
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
    "x-apple.systempreferences:com.apple.preference.security",
  ],
};

export interface SystemSettingsOpener {
  /** Opens a privacy pane; `unsupported` where there is no System Settings. Throws if it failed. */
  open(pane: ComputerPermissionPane): Promise<"opened" | "unsupported">;
}

/** Opens nothing: the default of `createApp`, so no test can open System Settings by accident. */
export const NO_SYSTEM_SETTINGS: SystemSettingsOpener = {
  open: async () => "unsupported",
};

export type OpenCommand = (file: string, args: readonly string[]) => Promise<void>;

const runOpen: OpenCommand = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
  });

/** The real opener: `open <deep link>` on macOS (only the links above, never caller input). */
export function createSystemSettingsOpener(
  options: { platform?: NodeJS.Platform; run?: OpenCommand } = {},
): SystemSettingsOpener {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runOpen;
  return {
    async open(pane) {
      if (platform !== "darwin") return "unsupported";
      let lastError: unknown;
      for (const link of SYSTEM_SETTINGS_LINKS[pane]) {
        try {
          await run("/usr/bin/open", [link]);
          return "opened";
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error("System Settings didn't open", { cause: lastError });
    },
  };
}
