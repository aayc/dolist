import { describe, expect, it } from "vitest";
import {
  createRemoteHosts,
  InvalidRemoteHostsError,
  normalizeRemoteHosts,
  RemoteHostRegistry,
} from "./remote-hosts";

describe("normalizeRemoteHosts", () => {
  it("lowercases, trims and collapses repeats", () => {
    expect(
      normalizeRemoteHosts([
        " VM-Name.Tailnet-Name.ts.net ",
        "vm-name.tailnet-name.ts.net",
        "a.b:8443",
      ]),
    ).toEqual(["vm-name.tailnet-name.ts.net", "a.b:8443"]);
  });

  it.each([
    "https://vm-name.tailnet-name.ts.net",
    "vm-name.tailnet-name.ts.net/",
    "user@vm-name.tailnet-name.ts.net",
    "100.64.0.1",
    "[fd7a:115c:a1e0::1]",
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "vm-name.tailnet-name.ts.net.",
    "vm-name.tailnet-name.ts.net:99999",
    "",
  ])("refuses %j", (host) => {
    expect(() => normalizeRemoteHosts([host])).toThrow(InvalidRemoteHostsError);
  });

  it("allows at most 8 distinct hosts", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `host-${i}.example.com`);
    expect(normalizeRemoteHosts([...eight, ...eight])).toHaveLength(8);
    expect(() => normalizeRemoteHosts([...eight, "host-8.example.com"])).toThrow(/At most 8/);
  });
});

describe("RemoteHostRegistry", () => {
  it("starts from a validated list and hands out a frozen copy", () => {
    const hosts = createRemoteHosts(["VM.example.com"]);
    expect(hosts).toBeInstanceOf(RemoteHostRegistry);
    expect(hosts.list()).toEqual(["vm.example.com"]);
    expect(Object.isFrozen(hosts.list())).toBe(true);
    expect(() => createRemoteHosts(["10.0.0.1"])).toThrow(InvalidRemoteHostsError);
  });

  it("notifies listeners of real changes only, until they unsubscribe", () => {
    const hosts = createRemoteHosts();
    const seen: Array<readonly string[]> = [];
    const off = hosts.onChange((list) => seen.push(list));
    hosts.set(["a.example.com"]);
    hosts.set(["A.example.com"]);
    hosts.set(["a.example.com", "b.example.com"]);
    off();
    hosts.set([]);
    expect(seen).toEqual([["a.example.com"], ["a.example.com", "b.example.com"]]);
    expect(hosts.list()).toEqual([]);
  });

  it("keeps the list unchanged when the new one is invalid", () => {
    const hosts = createRemoteHosts(["a.example.com"]);
    let calls = 0;
    hosts.onChange(() => calls++);
    expect(() => hosts.set(["b.example.com", "https://c.example.com"])).toThrow(
      InvalidRemoteHostsError,
    );
    expect(hosts.list()).toEqual(["a.example.com"]);
    expect(calls).toBe(0);
  });

  it("tells every listener even when one throws", () => {
    const hosts = createRemoteHosts();
    const seen: string[] = [];
    hosts.onChange(() => {
      throw new Error("listener bug");
    });
    hosts.onChange((list) => seen.push(list.join(",")));
    hosts.set(["a.example.com"]);
    expect(seen).toEqual(["a.example.com"]);
  });
});
