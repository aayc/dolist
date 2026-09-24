import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fc, test } from "@fast-check/vitest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../test-helpers";
import { loadOrCreateToken } from "../token";
import { ioRuns, ioTimeout, RecordingLogger } from "./harness";

/** File mode of the token file at each moment a token is written to it (-1 when it doesn't exist). */
const modesAtWrite = vi.hoisted(() => [] as number[]);
/** Runs once right before the next exclusive create, to stage a concurrent start. */
const hooks = vi.hoisted(() => ({
  beforeExclusiveCreate: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [target, , options] = args;
      if (typeof target === "string" && target.endsWith("daemon-token")) {
        const hook = hooks.beforeExclusiveCreate;
        if (hook && typeof options === "object" && options?.flag === "wx") {
          hooks.beforeExclusiveCreate = undefined;
          hook(target);
        }
        modesAtWrite.push(
          await actual.stat(target).then(
            (s) => s.mode & 0o777,
            () => -1,
          ),
        );
      }
      return actual.writeFile(...args);
    },
  };
});

const HEX = /^[0-9a-f]{64}$/;
let dir: { path: string; cleanup: () => void };
let path: string;
let counter = 0;

beforeAll(() => {
  dir = tempDir("ddl-token-");
});
afterAll(() => dir.cleanup());
beforeEach(() => {
  const home = join(dir.path, `t${counter++}`);
  mkdirSync(home);
  path = join(home, "daemon-token");
  modesAtWrite.length = 0;
});

describe("token file", () => {
  it.each([0o644, 0o640, 0o604, 0o666, 0o777, 0o660])(
    "tightens an existing valid token file with mode %o to 0600 and keeps the token",
    async (mode) => {
      const token = "ab".repeat(32);
      writeFileSync(path, `${token}\n`);
      chmodSync(path, mode);
      const logger = new RecordingLogger();
      expect(await loadOrCreateToken(path, logger)).toBe(token);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(logger.lines.join("\n")).toMatch(/restricted it to 0600/);
      expect(logger.lines.join("\n")).not.toContain(token);
    },
  );

  it.each([
    ["trailing newline", (t: string) => `${t}\n`],
    ["CRLF", (t: string) => `${t}\r\n`],
    ["surrounding spaces", (t: string) => `  ${t}  \n`],
    ["byte order mark", (t: string) => `\uFEFF${t}`],
  ])("reuses a valid token written with a %s", async (_name, render) => {
    const token = "cd".repeat(32);
    writeFileSync(path, render(token), { mode: 0o600 });
    expect(await loadOrCreateToken(path, new RecordingLogger())).toBe(token);
    expect(modesAtWrite).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["whitespace", " \n\t\n"],
    ["too short", "abc123"],
    ["63 hex digits", "a".repeat(63)],
    ["65 hex digits", "a".repeat(65)],
    ["upper-case hex", "A".repeat(64)],
    ["non-hex", "g".repeat(64)],
    ["two tokens", `${"a".repeat(64)}\n${"b".repeat(64)}`],
    ["token with junk", `${"a".repeat(64)} junk`],
    ["a JSON wrapper", JSON.stringify({ token: "a".repeat(64) })],
    ["binary", "\u0000\u0001\u00ff"],
  ])(
    "regenerates a %s token file, owner-only, without logging either token",
    async (_name, content) => {
      writeFileSync(path, content);
      chmodSync(path, 0o644);
      const logger = new RecordingLogger();
      const token = await loadOrCreateToken(path, logger);
      expect(token).toMatch(HEX);
      expect(readFileSync(path, "utf8")).toBe(`${token}\n`);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(logger.lines.join("\n")).toMatch(/malformed/);
      expect(logger.lines.join("\n")).not.toContain(token);
    },
  );

  it("never writes a new token while the file is readable by others", async () => {
    writeFileSync(path, "malformed");
    chmodSync(path, 0o644);
    await loadOrCreateToken(path, new RecordingLogger());
    expect(modesAtWrite).toEqual([0o600]);
  });

  it("creates a missing token file exclusively, owner-only from the first byte", async () => {
    const token = await loadOrCreateToken(path, new RecordingLogger());
    expect(modesAtWrite).toEqual([-1]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(`${token}\n`);
  });

  it("adopts the token of a concurrent start that created the file but is still writing it", async () => {
    const theirs = "ef".repeat(32);
    hooks.beforeExclusiveCreate = (target) => {
      writeFileSync(target, "", { mode: 0o600 });
      setTimeout(() => writeFileSync(target, `${theirs}\n`), 15);
    };
    const logger = new RecordingLogger();
    expect(await loadOrCreateToken(path, logger)).toBe(theirs);
    expect(readFileSync(path, "utf8")).toBe(`${theirs}\n`);
    expect(logger.lines.join("\n")).not.toMatch(/malformed/);
  });

  test.prop([fc.integer({ min: 2, max: 12 })], { numRuns: ioRuns(0.2) })(
    "gives concurrent first starts one token, the one on disk",
    async (starts) => {
      const tokens = await Promise.all(
        Array.from({ length: starts }, () => loadOrCreateToken(path, new RecordingLogger())),
      );
      const onDisk = readFileSync(path, "utf8").trim();
      expect(new Set(tokens)).toEqual(new Set([onDisk]));
    },
    ioTimeout(0.2),
  );
});
