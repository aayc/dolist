import { describe, expect, it } from "vitest";
import {
  defaultMachineName,
  formatPairingCode,
  isLoopbackHostname,
  isMachineUrl,
  isPairingCode,
  isRemoteHost,
  isSecureServiceUrl,
  normalizeDeviceName,
  normalizeMachineUrl,
  normalizePairingCode,
  normalizeRemoteHost,
  PAIRING_CODE_ALPHABET,
  REMOTE_LIMITS,
} from "./remote";

describe("isLoopbackHostname", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])("%s", (host) => {
    expect(isLoopbackHostname(host)).toBe(true);
  });

  it.each([
    "localhost.example.com",
    "128.0.0.1",
    "127.0.0.256",
    "127.0.0.01",
    "127.0.0",
    "0.0.0.0",
    "[::2]",
    "vm-name.tailnet-name.ts.net",
    "",
  ])("not %s", (host) => {
    expect(isLoopbackHostname(host)).toBe(false);
  });
});

describe("normalizeRemoteHost", () => {
  it.each([
    ["vm-name.tailnet-name.ts.net", "vm-name.tailnet-name.ts.net"],
    ["  VM-Name.Tailnet-Name.TS.net ", "vm-name.tailnet-name.ts.net"],
    ["vm-name.tailnet-name.ts.net:8443", "vm-name.tailnet-name.ts.net:8443"],
    ["vm-name", "vm-name"],
    ["xn--caf-dma.example", "xn--caf-dma.example"],
    ["a.b:65535", "a.b:65535"],
  ])("accepts %j as %j", (input, expected) => {
    expect(normalizeRemoteHost(input)).toBe(expected);
    expect(isRemoteHost(expected)).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["a scheme", "https://vm-name.tailnet-name.ts.net"],
    ["a path", "vm-name.tailnet-name.ts.net/app"],
    ["an IPv4 address", "100.64.0.1"],
    ["an IPv4 address with a port", "100.64.0.1:443"],
    ["a numeric last label", "vm.123"],
    ["an IPv6 address", "[fd7a:115c:a1e0::1]"],
    ["localhost", "localhost"],
    ["a .localhost name", "app.localhost"],
    ["a trailing dot", "vm-name.ts.net."],
    ["an empty label", "vm..ts.net"],
    ["a label starting with a hyphen", "-vm.ts.net"],
    ["an underscore", "vm_name.ts.net"],
    ["a label over 63 characters", `${"a".repeat(64)}.ts.net`],
    ["a name over 253 characters", `${"a.".repeat(126)}ab`],
    ["port 0", "vm.ts.net:0"],
    ["a port over 65535", "vm.ts.net:65536"],
    ["a port with a leading zero", "vm.ts.net:0443"],
    ["an empty port", "vm.ts.net:"],
    ["credentials", "user@vm.ts.net"],
    ["a space", "vm name.ts.net"],
    ["non-ASCII", "café.example"],
  ])("refuses %s", (_label, input) => {
    expect(normalizeRemoteHost(input)).toBeNull();
    expect(isRemoteHost(input)).toBe(false);
  });

  it("reports only normalized hosts as remote hosts", () => {
    expect(isRemoteHost("VM.ts.net")).toBe(false);
    expect(isRemoteHost(" vm.ts.net")).toBe(false);
  });
});

describe("normalizeMachineUrl", () => {
  it.each([
    ["https://vm-name.tailnet-name.ts.net", "https://vm-name.tailnet-name.ts.net"],
    ["https://vm-name.tailnet-name.ts.net/", "https://vm-name.tailnet-name.ts.net"],
    [" HTTPS://VM-Name.Tailnet-Name.ts.net:8443 ", "https://vm-name.tailnet-name.ts.net:8443"],
    ["https://vm-name.tailnet-name.ts.net:443", "https://vm-name.tailnet-name.ts.net"],
    ["http://127.0.0.1:7400", "http://127.0.0.1:7400"],
    ["http://localhost:7400/", "http://localhost:7400"],
    ["http://[::1]:7400", "http://[::1]:7400"],
    ["https://127.0.0.1:8443", "https://127.0.0.1:8443"],
  ])("accepts %j as %j", (input, expected) => {
    expect(normalizeMachineUrl(input)).toBe(expected);
    expect(isMachineUrl(expected)).toBe(true);
  });

  it.each([
    ["plain http to a remote host", "http://vm-name.tailnet-name.ts.net"],
    ["another scheme", "ftp://vm-name.tailnet-name.ts.net"],
    ["no scheme", "vm-name.tailnet-name.ts.net"],
    ["a path", "https://vm-name.tailnet-name.ts.net/api"],
    ["a query", "https://vm-name.tailnet-name.ts.net/?a=1"],
    ["an empty query", "https://vm-name.tailnet-name.ts.net?"],
    ["a fragment", "https://vm-name.tailnet-name.ts.net#x"],
    ["credentials", "https://user:secret@vm-name.tailnet-name.ts.net"],
    ["a user name", "https://user@vm-name.tailnet-name.ts.net"],
    ["an IP address", "https://100.64.0.1"],
    ["a shortened IP address", "https://1.2.3"],
    ["an underscore", "https://vm_name.ts.net"],
    ["a newline", "https://vm-name\n.tailnet-name.ts.net"],
    ["a tab", "https://vm-name.tailnet\t-name.ts.net"],
    ["garbage", "https://"],
    ["an empty string", ""],
  ])("refuses %s", (_label, input) => {
    expect(normalizeMachineUrl(input)).toBeNull();
  });

  it("reports only normalized URLs as machine URLs", () => {
    expect(isMachineUrl("https://vm-name.tailnet-name.ts.net/")).toBe(false);
    expect(isMachineUrl("https://VM.ts.net")).toBe(false);
  });

  it("names a machine after the first label of its host", () => {
    expect(defaultMachineName("https://vm-name.tailnet-name.ts.net:8443")).toBe("vm-name");
    expect(defaultMachineName("http://localhost:7400")).toBe("localhost");
    expect(defaultMachineName("http://[::1]:7400")).toBe("[::1]");
  });
});

describe("isSecureServiceUrl", () => {
  it.each([
    "https://sync.example.com",
    "https://sync.example.com/prefix",
    "http://127.0.0.1:7332",
    "http://localhost:7332",
    "http://[::1]:7332",
  ])("accepts %s", (url) => {
    expect(isSecureServiceUrl(url)).toBe(true);
  });

  it.each([
    "http://sync.example.com",
    "https://user:secret@sync.example.com",
    "ftp://sync.example.com",
    "sync.example.com",
    "https://sync.example.com\n",
    "",
  ])("refuses %j", (url) => {
    expect(isSecureServiceUrl(url)).toBe(false);
  });
});

describe("normalizeDeviceName", () => {
  it("trims and keeps names of 1 to 64 characters", () => {
    expect(normalizeDeviceName("  Work laptop ")).toBe("Work laptop");
    expect(normalizeDeviceName("x".repeat(REMOTE_LIMITS.deviceNameLength))).toHaveLength(64);
    expect(normalizeDeviceName("Café ☕")).toBe("Café ☕");
  });

  it.each(["", "   ", "x".repeat(65), "tab\tname", "line\nbreak"])("refuses %j", (name) => {
    expect(normalizeDeviceName(name)).toBeNull();
  });
});

describe("pairing codes", () => {
  it("use 8 characters without look-alikes", () => {
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[01ILOU]/);
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(PAIRING_CODE_ALPHABET.length);
  });

  it.each([
    ["ABCD2345", "ABCD2345"],
    ["abcd-2345", "ABCD2345"],
    [" ABCD 2345 ", "ABCD2345"],
    ["abcd2345", "ABCD2345"],
  ])("normalizes %j", (input, expected) => {
    expect(normalizePairingCode(input)).toBe(expected);
    expect(isPairingCode(expected)).toBe(true);
  });

  it.each(["", "ABCD234", "ABCD23456", "ABCD-O123", "ABCD_2345", "ABCDÉ234"])(
    "refuses %j",
    (input) => {
      expect(normalizePairingCode(input)).toBeNull();
    },
  );

  it("reports only canonical codes as pairing codes", () => {
    expect(isPairingCode("abcd2345")).toBe(false);
    expect(isPairingCode("ABCD-2345")).toBe(false);
  });

  it("shows a code as XXXX-XXXX", () => {
    expect(formatPairingCode("ABCD2345")).toBe("ABCD-2345");
    expect(formatPairingCode("ABC")).toBe("ABC");
  });
});
