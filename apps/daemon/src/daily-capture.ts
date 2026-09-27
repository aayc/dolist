import { createHash } from "node:crypto";
import {
  decodePersistedCapture,
  PERSISTED_PATHS,
  type PersistedCapture,
  WIRE_LIMITS,
} from "@ddl/contract";
import {
  type DailyAppendRequest,
  type DailyAppendResponse,
  isWithinWindow,
  type LocalDate,
  today,
  toISODate,
} from "@ddl/core";
import { ConflictError, type FileContent, type StorageProvider } from "@ddl/storage";
import type { AppContext } from "./context";
import { renderDailyNote, resolveDailyPath } from "./daily-note";
import { ApiError } from "./errors";
import type { Principal } from "./security";
import type { WriteSource } from "./write-tracker";

const MAX_ATTEMPTS = 8;
const pending = new WeakMap<StorageProvider, Map<string, Promise<DailyAppendResponse>>>();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function appendDailyCapture(
  ctx: AppContext,
  date: LocalDate,
  request: DailyAppendRequest,
  principal: Principal,
  source: WriteSource,
): Promise<DailyAppendResponse> {
  let operations = pending.get(ctx.storage);
  if (!operations) {
    operations = new Map();
    pending.set(ctx.storage, operations);
  }
  const key = `${principal.kind === "master" ? "master" : principal.device.id}:${request.operationId}`;
  const prior = operations.get(key) ?? Promise.resolve();
  const result = prior
    .catch(() => undefined)
    .then(() => performCapture(ctx, date, request, principal, source));
  operations.set(key, result);
  void result
    .finally(() => {
      if (operations.get(key) === result) operations.delete(key);
    })
    .catch(() => undefined);
  return result;
}

/** A prepared operation is never re-executed after an uncertain interruption. */
async function performCapture(
  ctx: AppContext,
  date: LocalDate,
  request: DailyAppendRequest,
  principal: Principal,
  source: WriteSource,
): Promise<DailyAppendResponse> {
  const workspaceId = await ctx.workspace.current();
  const hostId = ctx.workspace.hostId;
  if (request.hostId !== hostId)
    throw new ApiError(
      412,
      "host_mismatch",
      "This capture belongs to another host. Reconnect without replaying it here.",
    );
  try {
    new Intl.DateTimeFormat("en", { timeZone: request.timeZone });
  } catch {
    throw new ApiError(400, "invalid_request", "Unknown capture time zone");
  }
  if (!request.text.trim())
    throw new ApiError(400, "invalid_request", "Capture text must not be empty");
  const principalId = principal.kind === "master" ? "master" : `device:${principal.device.id}`;
  const iso = toISODate(date);
  // The binding includes the exact text (including whitespace), explicit date and capture context.
  const payloadHash = hash(
    JSON.stringify([
      workspaceId,
      hostId,
      principalId,
      iso,
      request.text,
      request.capturedAt,
      request.timeZone,
    ]),
  );
  const receiptPath = `${PERSISTED_PATHS.captures}/${hostId}/${hash(principalId)}/${request.operationId}.json`;
  const existing = await ctx.storage.read(receiptPath);
  if (existing) return recover(existing);
  const settings = ctx.settings.get();
  const path = resolveDailyPath(date, settings);
  const now = ctx.now();
  const context = {
    operationId: request.operationId,
    workspaceId,
    hostId,
    principal: principalId,
    payloadHash,
    path,
    date: iso,
    hostDate: toISODate(today(now)),
    hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    watched: isWithinWindow(
      date,
      today(now),
      settings.agent.watch.pastDays,
      settings.agent.watch.futureDays,
    ),
  };
  let receiptVersion: string | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await ctx.storage.read(path);
    const base =
      current?.content ?? (await renderDailyNote(ctx.storage, settings, path, date, now));
    const separator = base.length && !base.endsWith("\n") ? "\n" : "";
    const content = Buffer.from(
      base + separator + request.text + (request.text.endsWith("\n") ? "" : "\n"),
      "utf8",
    ).toString("utf8");
    if (
      content.length > WIRE_LIMITS.noteChars ||
      Buffer.byteLength(content) > WIRE_LIMITS.bodyBytes
    ) {
      throw new ApiError(413, "payload_too_large", "The captured note exceeds the note size limit");
    }
    const preparation: PersistedCapture = {
      version: 1,
      ...context,
      phase: "prepared",
      content,
      created: current === null,
    };
    try {
      const prepared = await ctx.storage.write(receiptPath, JSON.stringify(preparation), {
        ifMatch: receiptVersion,
      });
      receiptVersion = prepared.version;
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      const competing = await ctx.storage.read(receiptPath);
      if (!competing) throw error;
      return recover(competing);
    }
    try {
      const result = await ctx.storage.write(path, content, { ifMatch: current?.version ?? null });
      ctx.writes.record(result.path, result.version, source);
      const receipt: PersistedCapture = {
        ...preparation,
        phase: "applied",
        note: {
          path,
          content,
          version: result.version,
          mtime: result.mtime,
          date: iso,
          created: result.created,
        },
      };
      await ctx.storage.write(receiptPath, JSON.stringify(receipt), { ifMatch: receiptVersion });
      return response(receipt);
    } catch (error) {
      // Only a note CAS conflict proves this attempt did not write. A receipt failure is uncertain.
      if (!(error instanceof ConflictError) || error.path !== path) throw error;
    }
  }
  // The last CAS definitely failed, but retain the preparation: retries must not silently
  // reinterpret the same operation after a client has started reconciling it.
  throw new ApiError(
    409,
    "conflict",
    "The daily note kept changing. Reconcile the capture before retrying.",
  );

  async function recover(file: FileContent): Promise<DailyAppendResponse> {
    const decoded = decodePersistedCapture(file.content);
    if (!decoded.ok) throw new Error(`Capture receipt is ${decoded.kind}; refusing to replay it`);
    const receipt = decoded.value;
    if (
      receipt.operationId !== request.operationId ||
      receipt.payloadHash !== payloadHash ||
      receipt.workspaceId !== workspaceId ||
      receipt.hostId !== hostId ||
      receipt.principal !== principalId
    ) {
      throw new ApiError(
        409,
        "operation_conflict",
        "This operation ID was already used for another capture",
      );
    }
    if (
      receipt.phase === "applied" &&
      (!receipt.note ||
        receipt.note.content !== receipt.content ||
        receipt.note.path !== receipt.path ||
        receipt.note.date !== receipt.date)
    ) {
      throw new Error("Capture receipt has an inconsistent saved base; refusing to replay it");
    }
    if (receipt.phase !== "prepared") return response(receipt);
    const current = await ctx.storage.read(receipt.path);
    const recovered: PersistedCapture =
      current?.content === receipt.content
        ? {
            ...receipt,
            phase: "applied",
            note: {
              path: receipt.path,
              content: current.content,
              version: current.version,
              mtime: current.mtime,
              date: receipt.date,
              created: receipt.created,
            },
          }
        : { ...receipt, phase: "indeterminate" };
    await ctx.storage.write(receiptPath, JSON.stringify(recovered), { ifMatch: file.version });
    return response(recovered);
  }
}

function response(receipt: PersistedCapture): DailyAppendResponse {
  const common = {
    operationId: receipt.operationId,
    workspaceId: receipt.workspaceId,
    hostId: receipt.hostId,
    hostDate: receipt.hostDate,
    hostTimeZone: receipt.hostTimeZone,
    watched: receipt.watched,
  };
  if (receipt.phase === "applied" && receipt.note)
    return { ...common, outcome: "applied", note: receipt.note };
  return { ...common, outcome: "indeterminate", path: receipt.path };
}
