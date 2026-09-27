import { z } from "zod";

const envelope = {
  v: z.literal(1),
  id: z.string().uuid(),
  epoch: z.int().min(0),
  seq: z.int().min(1),
  at: z.int().min(0),
};

/** Every line is essential: skipping a corrupt preparation could dispatch a command twice. */
export const PersistedMutationEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("mutation.prepared"),
    operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    workspaceId: z.string().min(1).max(128),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    method: z.literal("POST"),
    path: z.string().startsWith("/api/"),
    owner: z.string().uuid(),
  }),
  z.object({
    ...envelope,
    type: z.literal("mutation.completed"),
    preparedId: z.string().uuid(),
    status: z.int().min(200).max(599),
    body: z.string().refine((text) => {
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    }, "not JSON"),
  }),
]);

export type PersistedMutationEvent = z.infer<typeof PersistedMutationEventSchema>;

/** Corrupt/newer journals remain untouched and fail closed; no request body appears in errors. */
export function decodePersistedMutationJournal(text: string): PersistedMutationEvent[] {
  const events: PersistedMutationEvent[] = [];
  const seen = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Invalid mutation journal JSON");
    }
    const parsed = PersistedMutationEventSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid or newer mutation journal event");
    const canonical = JSON.stringify(parsed.data);
    const known = seen.get(parsed.data.id);
    if (known && known !== canonical) throw new Error("Conflicting mutation journal event");
    if (known) continue;
    seen.set(parsed.data.id, canonical);
    events.push(parsed.data);
  }
  events.sort((a, b) => a.epoch - b.epoch || a.seq - b.seq || a.id.localeCompare(b.id));
  const [prepared, completed] = events;
  if (
    events.length < 1 ||
    events.length > 2 ||
    prepared?.type !== "mutation.prepared" ||
    (completed && (completed.type !== "mutation.completed" || completed.preparedId !== prepared.id))
  ) {
    throw new Error("Invalid mutation journal history");
  }
  return events;
}
