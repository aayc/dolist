/**
 * Artifact bodies are not JSON: `.daily-do-list/artifacts/<threadId>/<artifactId>.<ext>` holds the
 * UTF-8 text as-is, and binary bodies (the storage API is text-only) are base64 under an extra
 * `.b64` suffix. Their metadata (`ArtifactMeta`) lives in the owning thread file.
 */
import { PERSISTED_PATHS } from "./primitives";

export const PERSISTED_BINARY_ARTIFACT_SUFFIX = ".b64";

/**
 * True for a clean vault path strictly inside the artifacts folder (at least
 * `artifacts/<thread>/<file>`). Readers refuse anything else, so a crafted thread file cannot point
 * an artifact at a note or at other sidecar state.
 */
export function isPersistedArtifactPath(path: string): boolean {
  if (!path.startsWith(`${PERSISTED_PATHS.artifacts}/`)) return false;
  if (/[\\\0]/.test(path)) return false;
  const segments = path.split("/");
  if (segments.length < 4) return false;
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Canonical base64 of a binary artifact body, or null if it is not base64. Writers emit standard
 * padded base64 (RFC 4648 §4) on one line; readers also accept line breaks and missing padding.
 */
export function normalizePersistedBase64(text: string): string | null {
  const compact = text.replace(/\s+/g, "");
  if (!BASE64_BODY.test(compact)) return null;
  const padding = compact.length - compact.replace(/=+$/, "").length;
  if (padding > 0 && compact.length % 4 !== 0) return null;
  const bare = compact.slice(0, compact.length - padding);
  if (bare.length % 4 === 1) return null;
  return bare.padEnd(Math.ceil(bare.length / 4) * 4, "=");
}
