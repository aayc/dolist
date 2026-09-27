import { z } from "zod";
import {
  PersistedIdSchema,
  PersistedTaskAgentStatusSchema,
  PersistedTimestampSchema,
} from "./primitives";

/** One immutable decision per run. Null records deliberate suppression, not a missing result. */
export const PersistedNotificationEventSchema = z.object({
  v: z.literal(1),
  type: z.literal("routine.notification.decided"),
  id: PersistedIdSchema,
  epoch: z.int().min(0),
  seq: z.int().min(1),
  at: PersistedTimestampSchema,
  workspaceId: PersistedIdSchema,
  runId: PersistedIdSchema,
  notification: z
    .object({
      id: PersistedIdSchema,
      routineId: PersistedIdSchema,
      title: z.string(),
      body: z.string(),
      threadId: PersistedIdSchema,
      status: PersistedTaskAgentStatusSchema,
      at: PersistedTimestampSchema,
    })
    .nullable(),
});
export type PersistedNotificationEvent = z.infer<typeof PersistedNotificationEventSchema>;
