import type { AgentReadiness } from "@ddl/core";
import { describe, expect, it } from "vitest";
import {
  deviceNameProblem,
  machineUrlFromInput,
  machineUrlProblem,
  remoteHostFromInput,
  remoteHostProblem,
  syncTokenProblem,
  syncUrlProblem,
  syncVaultProblem,
} from "./inputs";
import { readinessRows } from "./readiness";

describe("the machine's address", () => {
  it.each([
    ["https://vm-name.tailnet-name.ts.net", "https://vm-name.tailnet-name.ts.net"],
    ["HTTPS://VM-Name.tailnet-name.ts.net/", "https://vm-name.tailnet-name.ts.net"],
    ["vm-name.tailnet-name.ts.net", "https://vm-name.tailnet-name.ts.net"],
    ["vm-name.tailnet-name.ts.net:8443", "https://vm-name.tailnet-name.ts.net:8443"],
    ["http://127.0.0.1:7331", "http://127.0.0.1:7331"],
    ["http://vm-name.tailnet-name.ts.net", null],
    ["https://vm-name.tailnet-name.ts.net/app", null],
    ["https://100.64.0.1", null],
    ["  ", null],
  ])("%j → %j", (raw, url) => {
    expect(machineUrlFromInput(raw)).toBe(url);
  });

  it("says what's wrong", () => {
    expect(machineUrlProblem("")).toBe("Enter the machine's address.");
    expect(machineUrlProblem("https://x.example/path")).toContain("without a path");
    expect(machineUrlProblem("vm.example")).toBeNull();
  });
});

describe("remote hosts", () => {
  it("takes a pasted https address as its host", () => {
    expect(remoteHostFromInput(" https://VM-Name.tailnet-name.ts.net/ ")).toBe(
      "vm-name.tailnet-name.ts.net",
    );
    expect(remoteHostFromInput("vm.example:8443")).toBe("vm.example:8443");
    expect(remoteHostFromInput("100.64.0.1")).toBeNull();
    expect(remoteHostFromInput("vm.example/path")).toBeNull();
    expect(remoteHostFromInput("localhost")).toBeNull();
  });

  it("refuses repeats and more than eight", () => {
    expect(remoteHostProblem("", [])).toBe("Enter a name.");
    expect(remoteHostProblem("a.example", ["a.example"])).toBe("It's already in the list.");
    const eight = Array.from({ length: 8 }, (_, i) => `vm-${i}.example`);
    expect(remoteHostProblem("b.example", eight)).toBe("At most 8 names: remove one first.");
    expect(remoteHostProblem("http://a.example", [])).toContain("DNS name");
    expect(remoteHostProblem("b.example", ["a.example"])).toBeNull();
  });
});

describe("sync fields", () => {
  it("wants an https address (http only on this computer)", () => {
    expect(syncUrlProblem("")).toBe("Enter the sync service's address.");
    expect(syncUrlProblem("http://sync.example.com")).toContain("https://");
    expect(syncUrlProblem("https://user:pw@sync.example.com")).toContain("without a user name");
    expect(syncUrlProblem("https://sync.example.com/ddl")).toBeNull();
    expect(syncUrlProblem("http://127.0.0.1:7332")).toBeNull();
  });

  it("wants a vault id and, unless one is saved, a token", () => {
    expect(syncVaultProblem("")).toBe("Enter the vault id.");
    expect(syncVaultProblem("my vault")).toBe("Use 1–64 letters, digits, _ or -.");
    expect(syncVaultProblem("vault_1")).toBeNull();
    expect(syncTokenProblem("", false)).toBe("Paste the vault token.");
    expect(syncTokenProblem("", true)).toBeNull();
    expect(syncTokenProblem("a b", true)).toBe("The token is one line, without spaces.");
    expect(syncTokenProblem(" t0ken ", false)).toBeNull();
  });

  it("wants a device name of at most 64 characters", () => {
    expect(deviceNameProblem(" ")).toBe("Enter a name.");
    expect(deviceNameProblem("x".repeat(65))).toBe("Use at most 64 characters.");
    expect(deviceNameProblem("Laptop")).toBeNull();
  });
});

describe("readiness rows", () => {
  const ready: AgentReadiness = {
    harness: { kind: "pi", ready: true },
    modelCredential: true,
    browser: true,
    computer: "available",
    connectors: { configured: 2, connected: 2 },
  };

  it("are all fine on a ready device", () => {
    const rows = readinessRows(ready, "here");
    expect(rows.map((r) => [r.key, r.state, r.value])).toEqual([
      ["harness", "ok", "Pi is ready"],
      ["credential", "ok", "Present"],
      ["browser", "ok", "Available"],
      ["computer", "ok", "Available"],
      ["connectors", "ok", "2 of 2 connected"],
    ]);
    expect(rows.every((r) => r.hint === undefined)).toBe(true);
  });

  it("say how to fix each problem, here and on the machine", () => {
    const signedOut =
      "The Cursor CLI is not signed in. Run `agent login` in a terminal, then restart the daemon — or switch the agent harness back to Pi in Settings.";
    const broken: AgentReadiness = {
      harness: { kind: "cursor", ready: false, problem: signedOut },
      modelCredential: false,
      browser: false,
      computer: "needs_permissions",
      connectors: { configured: 3, connected: 1 },
    };
    const here = readinessRows(broken, "here");
    expect(here.map((r) => r.state)).toEqual([
      "warning",
      "warning",
      "warning",
      "warning",
      "warning",
    ]);
    // The daemon's problem (a sentence with what to do) is the hint, not the chip.
    expect(here[0]).toMatchObject({ value: "Cursor CLI isn't ready", hint: signedOut });
    // Signing the CLI in is the credential too: said once, in the Agent row.
    expect(here[1]).toMatchObject({ value: "Missing" });
    expect(here[1]?.hint).toBeUndefined();
    expect(here[3]).toMatchObject({ value: "Needs permissions", section: "computer" });
    expect(here[4]).toMatchObject({ value: "1 of 3 connected", section: "connectors" });
    const machine = readinessRows(broken, "machine");
    expect(machine[2]?.hint).toBe("Install Google Chrome or Chromium on the machine.");
    expect(machine.some((r) => r.section)).toBe(false);
    expect(
      readinessRows({ ...broken, harness: { kind: "cursor", ready: false } }, "here")[0]?.hint,
    ).toBe("Install the Cursor CLI on this device and sign in with `agent login`.");

    const noKey = readinessRows(
      {
        ...ready,
        harness: {
          kind: "pi",
          ready: false,
          problem: "OPENROUTER_API_KEY is not set on this machine.",
        },
        modelCredential: false,
      },
      "machine",
    );
    expect(noKey[0]).toMatchObject({
      value: "Pi isn't ready",
      hint: "OPENROUTER_API_KEY is not set on this machine.",
    });
    expect(noKey[1]?.hint).toBe("Add OPENROUTER_API_KEY to ~/.daily-do-list/.env on the machine.");
  });

  it("don't count what a machine simply lacks as a problem", () => {
    const linux = readinessRows(
      { ...ready, computer: "unsupported", connectors: { configured: 0, connected: 0 } },
      "machine",
    );
    expect(linux[3]).toMatchObject({ state: "none", value: "Not on this machine" });
    expect(linux[4]).toMatchObject({ state: "none", value: "None set up" });
  });
});
