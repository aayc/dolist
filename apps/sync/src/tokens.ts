import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const MAX_TOKEN_LENGTH = 512;

/** A new vault token: 32 random bytes, base64url. Shown once; only its hash is stored. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Constant-time comparison of two token hashes. */
export function sameHash(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/** The credentials of an `Authorization: Bearer <token>` header. */
export function parseBearer(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const token = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
  return token && token.length <= MAX_TOKEN_LENGTH ? token : undefined;
}
