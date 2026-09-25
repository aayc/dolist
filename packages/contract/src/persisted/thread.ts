/**
 * `.daily-do-list/threads/<threadId>.json` — one agent thread (the conversation attached to a to-do
 * item): messages, artifact metadata and live surfaces. Written by the thread store
 * (packages/agent/src/threads/store.ts), compact JSON with a trailing newline.
 *
 * v1: the unversioned shape written before formats were versioned, plus `version: 1`.
 */
import { z } from "zod";
import { isPersistedArtifactPath } from "./artifact";
import {
  decodePersisted,
  PersistedCorruption,
  type PersistedDecodeResult,
  type PersistedDocument,
  type PersistedFormatSpec,
  type PersistedIssue,
  PersistedListSchema,
  readEnvelope,
  salvageList,
} from "./common";
import {
  PERSISTED_FILE_ID_PATTERN,
  PersistedArtifactKindSchema,
  PersistedCountSchema,
  PersistedFileIdSchema,
  PersistedIdSchema,
  PersistedSurfaceKindSchema,
  PersistedTaskAgentStatusSchema,
  PersistedTimestampSchema,
} from "./primitives";

export const PERSISTED_THREAD_VERSION = 1;

export const PersistedMessageAuthorSchema = z.union([
  z.literal("you"),
  z.literal("orchestrator"),
  z.literal("system"),
  z.templateLiteral(["subagent:", z.string()]),
]);

const messageBase = {
  id: PersistedIdSchema,
  author: PersistedMessageAuthorSchema,
  createdAt: PersistedTimestampSchema,
};

export const PersistedThreadMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    ...messageBase,
    kind: z.literal("text"),
    role: z.enum(["agent", "user", "system"]),
    text: z.string(),
    streaming: z.boolean().optional(),
  }),
  z.object({
    ...messageBase,
    kind: z.literal("tool_call"),
    toolCallId: z.string(),
    toolName: z.string(),
    label: z.string().optional(),
    /** Tool arguments as JSON; absent when the call had none (JSON has no `undefined`). */
    input: z.unknown().default(undefined),
    status: z.enum(["running", "ok", "error", "blocked"]),
    resultPreview: z.string().optional(),
    endedAt: PersistedTimestampSchema.optional(),
  }),
  z.object({ ...messageBase, kind: z.literal("approval"), approvalId: z.string() }),
  z.object({ ...messageBase, kind: z.literal("artifact"), artifactId: z.string() }),
  z.object({
    ...messageBase,
    kind: z.literal("status"),
    status: PersistedTaskAgentStatusSchema,
    text: z.string().optional(),
  }),
]);
export type PersistedThreadMessage = z.infer<typeof PersistedThreadMessageSchema>;

export const PersistedArtifactMetaSchema = z.object({
  id: PersistedIdSchema,
  threadId: PersistedIdSchema,
  title: z.string(),
  kind: PersistedArtifactKindSchema,
  mimeType: z.string(),
  language: z.string().optional(),
  /** Vault path of the body, always under `.daily-do-list/artifacts/`. */
  path: z.string().refine(isPersistedArtifactPath, "not a path inside .daily-do-list/artifacts/"),
  size: PersistedCountSchema,
  createdAt: PersistedTimestampSchema,
});
export type PersistedArtifactMeta = z.infer<typeof PersistedArtifactMetaSchema>;

export const PersistedCitedSourceSchema = z.object({
  url: z.string().min(1).max(2_000),
  title: z.string().max(500).optional(),
  snippet: z.string().max(1_000).optional(),
});
export type PersistedCitedSource = z.infer<typeof PersistedCitedSourceSchema>;

const threadFields = {
  id: PersistedFileIdSchema,
  taskId: z.string().nullable(),
  notePath: z.string().nullable(),
  title: z.string(),
  status: PersistedTaskAgentStatusSchema,
  createdAt: PersistedTimestampSchema,
  updatedAt: PersistedTimestampSchema,
};

/** The complete v1 file, as writers must produce it. */
export const PersistedThreadFileSchema = z.object({
  version: z.literal(PERSISTED_THREAD_VERSION),
  ...threadFields,
  messages: z.array(PersistedThreadMessageSchema),
  artifacts: z.array(PersistedArtifactMetaSchema),
  surfaces: z.array(PersistedSurfaceKindSchema),
  /** Web pages the thread cites (citation previews). */
  sources: z.array(PersistedCitedSourceSchema).optional(),
  /** A routine's run: the routine it belongs to (`rtn_…`). */
  routineId: PersistedIdSchema.optional(),
});
export type PersistedThreadFile = z.infer<typeof PersistedThreadFileSchema>;
/** The in-memory thread (`Thread` in @ddl/core): the file without `version`. */
export type PersistedThread = Omit<PersistedThreadFile, "version">;

const ThreadEnvelopeSchema = z.object({
  ...threadFields,
  messages: PersistedListSchema,
  artifacts: PersistedListSchema,
  surfaces: PersistedListSchema,
  sources: PersistedListSchema.optional(),
  // A malformed routine id only loses the grouping, never the thread.
  routineId: z.unknown().optional(),
});

const threadSpec: PersistedFormatSpec<PersistedThread> = {
  version: PERSISTED_THREAD_VERSION,
  // Before v1 the store wrote the same shape without `version` and its reader defaulted these.
  migrateUnversioned: (doc: PersistedDocument) => ({
    ...doc,
    version: 1,
    taskId: typeof doc.taskId === "string" ? doc.taskId : null,
    notePath: typeof doc.notePath === "string" ? doc.notePath : null,
    artifacts: Array.isArray(doc.artifacts) ? doc.artifacts : [],
    surfaces: Array.isArray(doc.surfaces) ? doc.surfaces : [],
  }),
  read(doc, issues) {
    const envelope = readEnvelope(ThreadEnvelopeSchema, doc);
    if (envelope instanceof PersistedCorruption) return envelope;
    const messages = salvageList(
      envelope.messages,
      PersistedThreadMessageSchema,
      "messages",
      issues,
      (m) => m.id,
    ).map(finishInterrupted);
    const artifacts = salvageList(
      envelope.artifacts,
      PersistedArtifactMetaSchema,
      "artifacts",
      issues,
      (a) => a.id,
    );
    const surfaces = [
      ...new Set(salvageList(envelope.surfaces, PersistedSurfaceKindSchema, "surfaces", issues)),
    ];
    const sources = envelope.sources
      ? salvageList(envelope.sources, PersistedCitedSourceSchema, "sources", issues, (s) => s.url)
      : [];
    const routineId = PersistedIdSchema.safeParse(envelope.routineId);
    if (envelope.routineId !== undefined && !routineId.success) {
      issues.push({ path: "routineId", message: "not a routine id" });
    }
    return {
      id: envelope.id,
      taskId: envelope.taskId,
      notePath: envelope.notePath,
      title: envelope.title,
      status: envelope.status,
      createdAt: envelope.createdAt,
      updatedAt: envelope.updatedAt,
      messages,
      artifacts,
      surfaces,
      ...(sources.length > 0 ? { sources } : {}),
      ...(routineId.success ? { routineId: routineId.data } : {}),
    };
  },
};

/** A message persisted mid-stream was interrupted (the writer died): readers treat it as final. */
export function finishInterruptedPersistedMessage(
  message: PersistedThreadMessage,
): PersistedThreadMessage {
  return message.kind === "text" && message.streaming ? { ...message, streaming: false } : message;
}
const finishInterrupted = finishInterruptedPersistedMessage;

/**
 * Reads a thread object with the file's rules (invalid entries dropped into `issues`, messages
 * saved mid-stream finished); `version` is not looked at. The journal's `thread.imported` events
 * carry threads in this shape.
 */
export function readPersistedThreadObject(
  doc: PersistedDocument,
  issues: PersistedIssue[],
): PersistedThread | PersistedCorruption {
  return threadSpec.read(doc, issues);
}

/**
 * With `expectedId` (see `persistedThreadIdFromPath`), a file whose content belongs to another
 * thread counts as corrupt: `threads/<id>.json` must hold thread `<id>`.
 */
export function decodePersistedThread(
  text: string,
  expectedId?: string,
): PersistedDecodeResult<PersistedThread> {
  const result = decodePersisted(threadSpec, text);
  if (result.ok && expectedId !== undefined && result.value.id !== expectedId) {
    return { ok: false, kind: "corrupt", reason: "thread id does not match the file name" };
  }
  return result;
}

/**
 * The thread a file name promises: `threads/<id>.json` → `<id>`. Null for any other name, such as
 * a sync conflict copy (`<id> (conflict 2026-09-23 1830).json`), whose content is merged into the
 * thread it holds.
 */
export function persistedThreadIdFromPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name.endsWith(".json")) return null;
  const id = name.slice(0, -".json".length);
  return PERSISTED_FILE_ID_PATTERN.test(id) ? id : null;
}

/** Exactly the v1 fields, compact, newline-terminated. */
export function encodePersistedThread(thread: PersistedThread): string {
  const file: PersistedThreadFile = {
    version: PERSISTED_THREAD_VERSION,
    id: thread.id,
    taskId: thread.taskId,
    notePath: thread.notePath,
    title: thread.title,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: thread.messages,
    artifacts: thread.artifacts,
    surfaces: thread.surfaces,
    ...(thread.sources?.length ? { sources: thread.sources } : {}),
    ...(thread.routineId ? { routineId: thread.routineId } : {}),
  };
  return `${JSON.stringify(file)}\n`;
}

/**
 * Merges two copies of the same thread without losing anything: another device's copy found at
 * write time, or a sync conflict copy found at load. Messages and artifacts are unioned by id
 * (`ours` wins for an id present in both; entries only in `theirs` are interleaved by `createdAt`),
 * surfaces are unioned, and title/status/taskId/notePath come from the copy updated last (ties:
 * `ours`). Idempotent: merging the result with `theirs` again changes nothing.
 */
export function mergePersistedThreads(
  ours: PersistedThread,
  theirs: PersistedThread,
): PersistedThread {
  const newer = theirs.updatedAt > ours.updatedAt ? theirs : ours;
  return {
    id: ours.id,
    taskId: newer.taskId,
    notePath: newer.notePath,
    title: newer.title,
    status: newer.status,
    createdAt: Math.min(ours.createdAt, theirs.createdAt),
    updatedAt: Math.max(ours.updatedAt, theirs.updatedAt),
    messages: unionByCreatedAt(ours.messages, theirs.messages),
    artifacts: unionByCreatedAt(ours.artifacts, theirs.artifacts),
    surfaces: [...new Set([...ours.surfaces, ...theirs.surfaces])],
    ...unionSources(ours.sources, theirs.sources),
    ...((ours.routineId ?? theirs.routineId)
      ? { routineId: (ours.routineId ?? theirs.routineId) as string }
      : {}),
  };
}

function unionSources(
  ours: readonly PersistedCitedSource[] | undefined,
  theirs: readonly PersistedCitedSource[] | undefined,
): { sources?: PersistedCitedSource[] } {
  const byUrl = new Map<string, PersistedCitedSource>();
  for (const source of [...(ours ?? []), ...(theirs ?? [])]) {
    if (!byUrl.has(source.url)) byUrl.set(source.url, source);
  }
  return byUrl.size > 0 ? { sources: [...byUrl.values()] } : {};
}

function unionByCreatedAt<T extends { id: string; createdAt: number }>(
  ours: readonly T[],
  theirs: readonly T[],
): T[] {
  const known = new Set(ours.map((item) => item.id));
  const extra = theirs.filter((item) => !known.has(item.id));
  if (extra.length === 0) return [...ours];
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < ours.length || j < extra.length) {
    const a = ours[i];
    const b = extra[j];
    if (b === undefined || (a !== undefined && a.createdAt <= b.createdAt)) {
      out.push(a!);
      i++;
    } else {
      out.push(b);
      j++;
    }
  }
  return out;
}
