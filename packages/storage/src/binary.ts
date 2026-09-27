import { SYNC_LIMITS } from "@ddl/core";
import {
  FileTooLargeError,
  InvalidTextFileError,
  type ReadBinaryOptions,
  StorageError,
} from "./types";

export function binaryReadLimit(options: ReadBinaryOptions = {}): number {
  const limit = options.maxBytes ?? SYNC_LIMITS.fileBytes;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 256 * 1024 * 1024) {
    throw new StorageError("Invalid binary read limit");
  }
  return limit;
}

export function checkBinarySize(
  path: string,
  bytes: Uint8Array,
  maxBytes = SYNC_LIMITS.fileBytes,
): void {
  if (bytes.byteLength > maxBytes) throw new FileTooLargeError(path, maxBytes);
}

export function decodeText(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new InvalidTextFileError(path);
  }
}

export async function binaryDigest(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
