/** Helpers for this package's own tests. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "@ddl/core";
import { afterEach } from "vitest";

/**
 * Temp directories removed after each test. Call it before the file's own `afterEach`: after
 * hooks run in reverse, so whatever that one stops is gone before its directory is.
 */
export function useTempDirs(defaultPrefix = "ddl-test-"): (prefix?: string) => Promise<string> {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  return async (prefix = defaultPrefix) => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
}

/** Polls `check` until it holds; the timeout is a failure bound only. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}
