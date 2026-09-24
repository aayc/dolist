import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { silentLogger } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "./test-helpers";
import { createTokenVerifier, loadOrCreateToken, parseBearer } from "./token";

let dir: { path: string; cleanup: () => void };
let path: string;

beforeEach(() => {
  dir = tempDir();
  path = join(dir.path, "daemon-token");
});
afterEach(() => dir.cleanup());

describe("daemon token", () => {
  it("creates a 256-bit hex token readable only by the owner", async () => {
    const token = await loadOrCreateToken(path, silentLogger);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf8").trim()).toBe(token);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reuses an existing token and tightens loose permissions", async () => {
    const first = await loadOrCreateToken(path, silentLogger);
    chmodSync(path, 0o644);
    expect(await loadOrCreateToken(path, silentLogger)).toBe(first);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("replaces a malformed token file", async () => {
    writeFileSync(path, "short\n", { mode: 0o600 });
    const token = await loadOrCreateToken(path, silentLogger);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf8").trim()).toBe(token);
  });

  it("verifies candidates and parses bearer headers", () => {
    const verify = createTokenVerifier("a".repeat(64));
    expect(verify("a".repeat(64))).toBe(true);
    expect(verify("a".repeat(63))).toBe(false);
    expect(verify("")).toBe(false);
    expect(verify(undefined)).toBe(false);
    expect(verify("a".repeat(10_000))).toBe(false);
    expect(parseBearer("Bearer abc")).toBe("abc");
    expect(parseBearer("bearer   abc  ")).toBe("abc");
    expect(parseBearer("Basic abc")).toBeUndefined();
    expect(parseBearer("Bearer a b")).toBeUndefined();
  });
});
