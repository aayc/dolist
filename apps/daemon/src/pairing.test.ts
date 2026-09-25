import { isPairingCode } from "@ddl/core";
import { beforeEach, describe, expect, it } from "vitest";
import { PAIRING_LIMITS, PairingCodes } from "./pairing";

let clock: number;
let codes: PairingCodes;

beforeEach(() => {
  clock = 1_790_000_000_000;
  codes = new PairingCodes({ now: () => clock });
});

const issue = (name?: string) => {
  const issued = codes.issue(name);
  if (!issued) throw new Error("no code issued");
  return issued;
};

describe("issuing codes", () => {
  it("issues 8 characters of the unambiguous alphabet, valid for 5 minutes", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const fresh = new PairingCodes({ now: () => clock });
      const { code, expiresAt } = fresh.issue()!;
      expect(isPairingCode(code), code).toBe(true);
      expect(expiresAt).toBe(clock + 5 * 60_000);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(195);
  });

  it(`keeps at most ${PAIRING_LIMITS.maxOutstanding} outstanding`, () => {
    const first = issue();
    issue();
    issue();
    expect(codes.issue()).toBeNull();
    expect(codes.redeem(first.code)).not.toBeNull();
    const fourth = issue();
    expect(codes.issue()).toBeNull();
    clock = fourth.expiresAt;
    expect(codes.outstanding).toBe(0);
    expect(codes.issue()).not.toBeNull();
  });
});

describe("redeeming codes", () => {
  it("accepts a code once, with the name its issuer gave", () => {
    const named = issue("Phone");
    const unnamed = issue();
    expect(codes.redeem(named.code)).toEqual({ name: "Phone" });
    expect(codes.redeem(named.code)).toBeNull();
    expect(codes.redeem(unnamed.code)).toEqual({ name: undefined });
  });

  it("refuses a code from the moment it expires", () => {
    const early = issue();
    const late = issue();
    clock = early.expiresAt - 1;
    expect(codes.redeem(early.code)).not.toBeNull();
    clock = late.expiresAt;
    expect(codes.redeem(late.code)).toBeNull();
  });

  it("refuses near misses", () => {
    const { code } = issue();
    for (const miss of [code.slice(0, 7), `${code}2`, code.toLowerCase(), ""]) {
      expect(codes.redeem(miss), miss).toBeNull();
    }
    expect(codes.redeem(code)).not.toBeNull();
  });

  it(`invalidates every outstanding code after ${PAIRING_LIMITS.failuresBeforeInvalidation} failures`, () => {
    const a = issue();
    const b = issue();
    for (let i = 0; i < PAIRING_LIMITS.failuresBeforeInvalidation - 1; i++) {
      expect(codes.redeem("ZZZZZZZZ")).toBeNull();
    }
    expect(codes.redeem(a.code)).not.toBeNull();
    expect(codes.redeem("ZZZZZZZZ")).toBeNull();
    expect(codes.outstanding).toBe(0);
    expect(codes.redeem(b.code)).toBeNull();
    // The count starts over: a new code survives the next nine misses.
    const c = issue();
    for (let i = 0; i < PAIRING_LIMITS.failuresBeforeInvalidation - 2; i++)
      codes.redeem("ZZZZZZZZ");
    expect(codes.redeem(c.code)).not.toBeNull();
  });
});

describe("the attempt limit", () => {
  it(`allows ${PAIRING_LIMITS.attemptsPerWindow} attempts a minute, globally`, () => {
    for (let i = 0; i < PAIRING_LIMITS.attemptsPerWindow; i++) {
      expect(codes.attempt()).toEqual({ allowed: true });
      clock += 1_000;
    }
    expect(codes.attempt()).toEqual({ allowed: false, retryAfterMs: 55_000 });
    clock += 10_000;
    // Refused attempts don't extend the wait.
    expect(codes.attempt()).toEqual({ allowed: false, retryAfterMs: 45_000 });
    clock += 45_000;
    expect(codes.attempt()).toEqual({ allowed: true });
    expect(codes.attempt()).toEqual({ allowed: false, retryAfterMs: 1_000 });
  });
});
