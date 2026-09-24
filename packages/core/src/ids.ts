const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

type CryptoLike = { getRandomValues<T extends Uint8Array>(array: T): T };

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(bytes);
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

/**
 * Random, URL-safe, lowercase identifier. 12 base36 chars ≈ 62 bits of entropy.
 * `createId("thr")` → `thr_k3j9x0q2m1ab`.
 */
export function createId(prefix?: string, length = 12): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return prefix ? `${prefix}_${out}` : out;
}
