import { normalizeDeviceName, normalizePath, REMOTE_LIMITS, SYNC_LIMITS } from "@ddl/core";
import { z } from "zod";

/** Size limits of the wire protocol. The daemon enforces the request-side ones. */
export const WIRE_LIMITS = {
  /** Identifiers: task, thread, approval, artifact, message and tool-call ids. */
  idLength: 200,
  clientIdLength: 128,
  /** Vault paths a client may send. */
  requestPathLength: 1024,
  /** Vault paths the daemon reports (files created outside the app may nest deeper). */
  responsePathLength: 4096,
  versionLength: 256,
  /** Characters of note content accepted by `PUT /api/notes/*` (5 MiB). */
  noteChars: 5 * 1024 * 1024,
  /** Request bodies of any `/api/*` route (5 MB). */
  bodyBytes: 5 * 1024 * 1024,
  userMessageChars: 20_000,
  decisionNoteChars: 2_000,
  searchQueryChars: 500,
  /** `?limit=` of `/api/search` is capped (not rejected) at this. */
  searchLimit: 200,
  modelIdLength: 200,
  nameLength: 200,
  vaultNameLength: 1024,
  /** Pixel size of a surface frame. */
  frameSide: 16_384,
} as const;

/**
 * Runtime ids that appear in URLs (`/api/threads/:id`, `/api/approvals/:id`, artifacts). `.` and
 * `..` are excluded: URL parsers resolve them as dot segments, so they can't address anything.
 */
export const RUNTIME_ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,200}$/;
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Any identifier inside a payload: non-empty and bounded. */
export const IdSchema = z.string().min(1).max(WIRE_LIMITS.idLength).describe("Identifier.");

/** An identifier clients put in URLs: `thr_k3j9x0q2m1ab`. */
export const RuntimeIdSchema = z
  .string()
  .regex(RUNTIME_ID_PATTERN, "must be 1-200 characters of A-Z a-z 0-9 _ . : - (not . or ..)")
  .describe("Runtime id, safe to use in URLs.");

/** Random id a client picks for itself (echoed on `vault.changed` so it can skip its own writes). */
export const ClientIdSchema = z
  .string()
  .regex(CLIENT_ID_PATTERN, "must be 1-128 characters of A-Z a-z 0-9 _ -")
  .describe("Client id chosen by the client.");

/** Milliseconds since the Unix epoch (a non-negative safe integer). */
export const EpochMsSchema = z.int().nonnegative().describe("Epoch milliseconds.");

/** Counts, sizes and 0-based line numbers. */
export const CountSchema = z.int().nonnegative();

/** A calendar date `YYYY-MM-DD` (validated, including leap days). */
export const IsoDateSchema = z.iso.date().describe("Local calendar date YYYY-MM-DD.");

/** A vault path as sent by a client; the daemon normalizes and validates it further. */
export const RequestPathSchema = z.string().min(1).max(WIRE_LIMITS.requestPathLength);

/** True for vault-relative POSIX paths without empty, `.` or `..` segments or backslashes. */
export function isCanonicalVaultPath(path: string): boolean {
  try {
    return path.length > 0 && normalizePath(path) === path;
  } catch {
    return false;
  }
}

/** A canonical vault path reported by the daemon, e.g. `Daily/2026-09-23.md`. */
export const VaultPathSchema = z
  .string()
  .min(1)
  .max(WIRE_LIMITS.responsePathLength)
  .refine(isCanonicalVaultPath, "must be a canonical vault-relative path")
  .describe("Canonical vault-relative path (no leading `/`, `.`/`..` or empty segments).");

/** Opaque content version (hash) used for optimistic concurrency. */
export const ContentVersionSchema = z
  .string()
  .min(1)
  .max(WIRE_LIMITS.versionLength)
  .describe("Opaque content version.");

/** Standard padded base64 (frame bytes). */
export const Base64Schema = z.base64().min(1);

/** A short machine name (connector, tool, execution provider). */
export const NameSchema = z.string().min(1).max(WIRE_LIMITS.nameLength);

/** A model id as reported by the daemon: non-empty, no surrounding whitespace. */
export const ModelIdSchema = z
  .string()
  .min(1)
  .max(WIRE_LIMITS.modelIdLength)
  .regex(/^\S(?:[\s\S]*\S)?$/, "must not start or end with whitespace");

const CONTROL = /\p{Cc}/u;
const TRIMMED = /^\S(?:[\s\S]*\S)?$/;

/** A device or machine name a client sends: trimmed, then 1–64 characters, no control characters. */
export const DeviceNameInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(REMOTE_LIMITS.deviceNameLength)
  .refine((name) => !CONTROL.test(name), "must not contain control characters");

/** A device or machine name the daemon reports after taking it from a client (`normalizeDeviceName`). */
export const DeviceNameSchema = z
  .string()
  .min(1)
  .max(REMOTE_LIMITS.deviceNameLength)
  .refine(
    (name) => normalizeDeviceName(name) === name,
    "must not start or end with whitespace or contain control characters",
  );

/** A device's name as other devices see it through the sync service (up to 100 characters). */
export const SyncDeviceNameSchema = z
  .string()
  .min(1)
  .max(SYNC_LIMITS.deviceNameLength)
  .regex(TRIMMED, "must not start or end with whitespace")
  .refine((name) => !CONTROL.test(name), "must not contain control characters");
