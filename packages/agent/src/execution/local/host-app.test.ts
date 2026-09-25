import { describe, expect, it } from "vitest";
import { findHostApp, outermostAppBundle, parseProcessTable } from "./host-app";
import { CommandError, type CommandRunner } from "./jxa";

const TABLE = [
  "    1     0 /sbin/launchd",
  "  400     1 /Applications/Cursor.app/Contents/MacOS/Cursor",
  "  410   400 Cursor Helper (Plugin): extension-host project [1-10]",
  "  420   410 /bin/zsh",
  "  430   420 node /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs dev",
  "  440   430 /opt/homebrew/bin/node",
  "  500     1 /Applications/Daily Do List.app/Contents/MacOS/Daily Do List",
  "  510   500 /opt/homebrew/bin/node",
  "  600     1 /usr/libexec/sshd-session",
  "  610   600 /opt/homebrew/bin/node",
].join("\n");

function runner(options: { bundleId?: string; failPlist?: boolean } = {}): CommandRunner {
  return async (file, args) => {
    if (file === "ps") return { stdout: TABLE, stderr: "" };
    if (file === "plutil") {
      if (options.failPlist) throw new CommandError("plutil failed", "no such file");
      expect(args.at(-1)).toMatch(/\.app\/Contents\/Info\.plist$/);
      return { stdout: `${options.bundleId ?? "com.example.host"}\n`, stderr: "" };
    }
    throw new Error(`unexpected ${file}`);
  };
}

describe("host app", () => {
  it("parses the process table", () => {
    const table = parseProcessTable(TABLE);
    expect(table.get(410)).toEqual({
      ppid: 400,
      comm: "Cursor Helper (Plugin): extension-host project [1-10]",
    });
    expect(table.size).toBe(10);
  });

  it("takes the outermost app bundle of an executable path", () => {
    expect(
      outermostAppBundle(
        "/Applications/Cursor.app/Contents/Frameworks/Helper.app/Contents/MacOS/H",
      ),
    ).toBe("/Applications/Cursor.app");
    expect(outermostAppBundle("/Applications/Daily Do List.app")).toBe(
      "/Applications/Daily Do List.app",
    );
    expect(outermostAppBundle("/bin/zsh")).toBeUndefined();
    expect(outermostAppBundle("Cursor Helper (Plugin): x.app/y")).toBeUndefined();
  });

  it("walks up to the nearest app, past processes that renamed themselves", async () => {
    expect(await findHostApp(runner({ bundleId: "com.example.editor" }), 440)).toEqual({
      name: "Cursor",
      path: "/Applications/Cursor.app",
      bundleId: "com.example.editor",
    });
    expect(await findHostApp(runner({ bundleId: "app.dailydolist.mac" }), 510)).toEqual({
      name: "Daily Do List",
      path: "/Applications/Daily Do List.app",
      bundleId: "app.dailydolist.mac",
    });
  });

  it("reports no host outside an app, and no bundle id when Info.plist can't be read", async () => {
    expect(await findHostApp(runner(), 610)).toBeUndefined();
    expect(await findHostApp(runner(), 9999)).toBeUndefined();
    expect(await findHostApp(runner({ failPlist: true }), 510)).toEqual({
      name: "Daily Do List",
      path: "/Applications/Daily Do List.app",
    });
  });
});
