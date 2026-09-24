import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import type { Logger } from "@ddl/core";

const TOKEN_RE = /^[0-9a-f]{64}$/;
const MAX_CANDIDATE_LENGTH = 512;

/**
 * Returns the daemon's bearer token, creating a fresh 256-bit token (file mode 0600) when the file
 * is missing or malformed. The token itself is never logged.
 */
export async function loadOrCreateToken(path: string, logger: Logger): Promise<string> {
  const existing = await readTokenFile(path);
  if (existing !== null && TOKEN_RE.test(existing)) {
    await restrictPermissions(path, logger);
    return existing;
  }
  const token = randomBytes(32).toString("hex");
  if (existing === null) {
    try {
      await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
      return token;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
      const raced = await readTokenFile(path);
      if (raced !== null && TOKEN_RE.test(raced)) return raced;
    }
  }
  logger.warn("Daemon token file was malformed; generated a new token");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}

/** Constant-time comparison against the expected token (digests equalize lengths). */
export function createTokenVerifier(
  token: string,
): (candidate: string | null | undefined) => boolean {
  const expected = digest(token);
  return (candidate) =>
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= MAX_CANDIDATE_LENGTH &&
    timingSafeEqual(digest(candidate), expected);
}

/** Extracts the credentials of an `Authorization: Bearer <token>` header. */
export function parseBearer(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  return /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

async function readTokenFile(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function restrictPermissions(path: string, logger: Logger): Promise<void> {
  if (process.platform === "win32") return;
  const { mode } = await stat(path);
  if ((mode & 0o077) === 0) return;
  await chmod(path, 0o600);
  logger.warn("Daemon token file was readable by other users; restricted it to 0600");
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
