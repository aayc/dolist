import { describe, expect, it } from "vitest";
import { discoverComputerHelper } from "./computer-helper";

const ENTRY = "/Applications/Daily Do List.app/Contents/Resources/daemon/dist/main.js";
const BUNDLED = "/Applications/Daily Do List.app/Contents/Resources/daemon/bin/ddl-computer";
const DEV = ["/repo/apps/macos/Packages/DailyDoListComputer/.build/release/ddl-computer"];

function discover(
  existing: string[],
  env: Record<string, string> = {},
  platform: NodeJS.Platform = "darwin",
) {
  return discoverComputerHelper({
    env,
    platform,
    cwd: "/work",
    entryScript: ENTRY,
    devBuilds: DEV,
    isExecutable: (path) => existing.includes(path),
  });
}

describe("discoverComputerHelper", () => {
  it("prefers DDL_COMPUTER_HELPER, then the bundled copy, then a dev build", () => {
    expect(
      discover(["/opt/ddl-computer", BUNDLED, DEV[0]!], {
        DDL_COMPUTER_HELPER: "/opt/ddl-computer",
      }),
    ).toEqual({
      path: "/opt/ddl-computer",
      source: "env",
    });
    expect(discover([BUNDLED, DEV[0]!])).toEqual({ path: BUNDLED, source: "bundled" });
    expect(discover([DEV[0]!])).toEqual({ path: DEV[0], source: "dev" });
    expect(discover([])).toEqual({});
  });

  it("resolves a relative DDL_COMPUTER_HELPER against the working directory", () => {
    expect(
      discover(["/work/bin/ddl-computer"], { DDL_COMPUTER_HELPER: "bin/ddl-computer" }),
    ).toEqual({
      path: "/work/bin/ddl-computer",
      source: "env",
    });
  });

  it("explains a configured helper that isn't executable instead of falling back", () => {
    expect(discover([BUNDLED], { DDL_COMPUTER_HELPER: "/nope" })).toEqual({
      problem: "DDL_COMPUTER_HELPER is not an executable file (/nope)",
    });
  });

  it("can be turned off, and finds nothing on other platforms", () => {
    for (const off of ["off", "none", "0", "FALSE"]) {
      expect(discover([BUNDLED], { DDL_COMPUTER_HELPER: off })).toEqual({});
    }
    expect(discover([BUNDLED], {}, "linux")).toEqual({});
  });
});
