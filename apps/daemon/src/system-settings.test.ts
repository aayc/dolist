import { describe, expect, it } from "vitest";
import {
  createSystemSettingsOpener,
  NO_SYSTEM_SETTINGS,
  SYSTEM_SETTINGS_LINKS,
} from "./system-settings";

describe("System Settings opener", () => {
  it("opens the first deep link that works, only on macOS", async () => {
    const runs: string[] = [];
    const opener = createSystemSettingsOpener({
      platform: "darwin",
      run: async (file, args) => {
        expect(file).toBe("/usr/bin/open");
        runs.push(args[0]!);
        if (runs.length === 1) throw new Error("no such anchor");
      },
    });
    expect(await opener.open("screenRecording")).toBe("opened");
    expect(runs).toEqual(SYSTEM_SETTINGS_LINKS.screenRecording.slice(0, 2));
    expect(runs[1]).toContain("Privacy_ScreenCapture");

    const linux = createSystemSettingsOpener({
      platform: "linux",
      run: async () => {
        throw new Error("must not run");
      },
    });
    expect(await linux.open("accessibility")).toBe("unsupported");
    expect(await NO_SYSTEM_SETTINGS.open("accessibility")).toBe("unsupported");
  });

  it("fails when no link opens", async () => {
    const opener = createSystemSettingsOpener({
      platform: "darwin",
      run: async () => {
        throw new Error("open failed");
      },
    });
    await expect(opener.open("accessibility")).rejects.toThrow("System Settings didn't open");
  });

  it("only knows fixed System Settings addresses", () => {
    for (const links of Object.values(SYSTEM_SETTINGS_LINKS)) {
      for (const link of links) expect(link).toMatch(/^x-apple\.systempreferences:com\.apple\./);
    }
    expect(SYSTEM_SETTINGS_LINKS.accessibility[0]).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
  });
});
