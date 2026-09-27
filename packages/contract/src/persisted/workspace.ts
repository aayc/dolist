import { isHiddenPath, toVaultPath } from "@ddl/core";
import { z } from "zod";
import { decodePersisted, readEnvelope } from "./common";
import {
  PersistedFileIdSchema,
  PersistedIsoDateSchema,
  PersistedTimestampSchema,
} from "./primitives";

/** Identity is fail-closed: malformed/newer files are never replaced with a fresh identity. */
export const PersistedWorkspaceSchema = z.looseObject({
  version: z.literal(1),
  workspaceId: PersistedFileIdSchema,
});

const pathSchema = z
  .string()
  .min(1)
  .refine((path) => {
    try {
      return toVaultPath(path) === path && !isHiddenPath(path);
    } catch {
      return false;
    }
  }, "not a visible canonical vault path");

const note = z.looseObject({
  path: pathSchema,
  content: z.string(),
  version: z.string(),
  mtime: PersistedTimestampSchema,
  date: PersistedIsoDateSchema,
  created: z.boolean(),
});

/** A preparation precedes every conditional file write. No automatic replay of a preparation. */
export const PersistedCaptureSchema = z.looseObject({
  version: z.literal(1),
  operationId: PersistedFileIdSchema,
  workspaceId: PersistedFileIdSchema,
  hostId: PersistedFileIdSchema,
  principal: z.string().min(1),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["prepared", "applied", "indeterminate"]),
  path: pathSchema,
  date: PersistedIsoDateSchema,
  content: z.string(),
  created: z.boolean(),
  hostDate: PersistedIsoDateSchema,
  hostTimeZone: z.string(),
  watched: z.boolean(),
  note: note.optional(),
});
export type PersistedCapture = z.infer<typeof PersistedCaptureSchema>;

export function decodePersistedWorkspace(text: string) {
  return decodePersisted(
    { version: 1, read: (doc) => readEnvelope(PersistedWorkspaceSchema, doc) },
    text,
  );
}
export function decodePersistedCapture(text: string) {
  return decodePersisted(
    { version: 1, read: (doc) => readEnvelope(PersistedCaptureSchema, doc) },
    text,
  );
}
