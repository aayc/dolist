import { basename, dirname, extname } from "@ddl/core";
import { binaryDigest, equalBytes } from "../binary";
import {
  type BinaryFileContent,
  ConflictError,
  type LeaseFence,
  StaleLeaseError,
  StorageError,
  type StorageProvider,
  type SyncReport,
  type WriteResult,
} from "../types";
import type { SyncDecision } from "./decide";
import type { SnapshotEntry, SyncSnapshot } from "./snapshot";

interface BinaryContext {
  snapshot: SyncSnapshot;
  taken: Set<string>;
  report: SyncReport;
  dirtySnapshot: boolean;
}

interface BinaryOptions {
  primary: StorageProvider;
  target: StorageProvider;
  fence?: LeaseFence | undefined;
  writePrimary(path: string, bytes: Uint8Array, ifMatch: string | null): Promise<WriteResult>;
  deletePrimary(path: string, ifMatch: string): Promise<void>;
}

/** Binary conflicts preserve both originals before replacing either side; no decoder or merge. */
export async function syncBinaryPath(
  path: string,
  decision: SyncDecision,
  base: SnapshotEntry | undefined,
  ctx: BinaryContext,
  options: BinaryOptions,
): Promise<void> {
  const { primary, target } = options;
  const record = (p: string, t: string) => remember(ctx, path, p, t);
  const forget = () => {
    ctx.snapshot.entries.delete(path);
    ctx.dirtySnapshot = true;
  };
  const yieldToTarget = async () => {
    const [ours, theirs] = await Promise.all([primary.readBinary(path), target.readBinary(path)]);
    if (theirs) {
      const p =
        ours && equalBytes(ours.bytes, theirs.bytes)
          ? ours.version
          : (await options.writePrimary(path, theirs.bytes, ours?.version ?? null)).version;
      record(p, theirs.version);
      ctx.report.pulled.push(path);
    } else if (base) {
      if (ours) {
        await options.deletePrimary(path, ours.version);
        ctx.report.deletedLocal.push(path);
      }
      forget();
    }
  };
  if (decision.action === "skip") return;
  if (decision.action === "forget") {
    forget();
    return;
  }
  if (decision.action === "pull") {
    const source = await required(target, path);
    const result = await options.writePrimary(
      path,
      source.bytes,
      decision.primary?.version ?? null,
    );
    record(result.version, source.version);
    ctx.report.pulled.push(path);
    return;
  }
  if (decision.action === "delete-primary") {
    await options.deletePrimary(path, decision.primary.version);
    forget();
    ctx.report.deletedLocal.push(path);
    return;
  }
  const fenced = options.fence?.covers(path) === true;
  if (fenced && options.fence?.epoch() === null) {
    await yieldToTarget();
    return;
  }
  try {
    if (decision.action === "delete-target") {
      await target.delete(path, { ifMatch: decision.target.version });
      forget();
      ctx.report.deletedRemote.push(path);
      return;
    }
    const ours = await required(primary, path);
    if (decision.action === "push") {
      const result = await target.writeBinary(path, ours.bytes, {
        ifMatch: decision.target?.version ?? null,
      });
      record(ours.version, result.version);
      ctx.report.pushed.push(path);
      return;
    }
    const theirs = await required(target, path);
    if (equalBytes(ours.bytes, theirs.bytes)) {
      record(ours.version, theirs.version);
      return;
    }
    if (fenced) {
      const result = await target.writeBinary(path, ours.bytes, { ifMatch: theirs.version });
      record(ours.version, result.version);
      ctx.report.pushed.push(path);
      return;
    }
    const [oursHash, theirsHash] = await Promise.all([
      binaryDigest(ours.bytes),
      binaryDigest(theirs.bytes),
    ]);
    const keepPrimary =
      ours.mtime > theirs.mtime || (ours.mtime === theirs.mtime && oursHash >= theirsHash);
    const loser = keepPrimary ? theirs : ours;
    const loserHash = keepPrimary ? theirsHash : oursHash;
    const conflictPath = await preserveConflict(path, loser.bytes, loserHash, ctx, options);
    if (keepPrimary) {
      const result = await target.writeBinary(path, ours.bytes, { ifMatch: theirs.version });
      record(ours.version, result.version);
    } else {
      const result = await options.writePrimary(path, theirs.bytes, ours.version);
      record(result.version, theirs.version);
    }
    ctx.report.conflicts.push({ path, conflictPath });
  } catch (error) {
    if (!(error instanceof StaleLeaseError) || !fenced) throw error;
    await yieldToTarget();
  }
}

async function preserveConflict(
  path: string,
  bytes: Uint8Array,
  hash: string,
  ctx: BinaryContext,
  options: BinaryOptions,
): Promise<string> {
  const ext = extname(path);
  const name = basename(path);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const folder = dirname(path);
  for (let attempt = 1; attempt <= 50; attempt++) {
    const suffix = attempt === 1 ? "" : ` ${attempt}`;
    const filename = `${stem} (conflict ${hash.slice(0, 16)}${suffix})${ext}`;
    const candidate = folder ? `${folder}/${filename}` : filename;
    const [p, t] = await Promise.all([
      options.primary.readBinary(candidate),
      options.target.readBinary(candidate),
    ]);
    if ((p && !equalBytes(p.bytes, bytes)) || (t && !equalBytes(t.bytes, bytes))) continue;
    const local = p ?? (await options.writePrimary(candidate, bytes, null));
    // If this request fails, the original path is untouched and the durable local copy remains.
    const remote = t ?? (await options.target.writeBinary(candidate, bytes, { ifMatch: null }));
    remember(ctx, candidate, local.version, remote.version);
    ctx.taken.add(candidate);
    ctx.snapshot.conflicts.add(candidate);
    return candidate;
  }
  throw new StorageError("Cannot reserve a binary conflict copy", path);
}

async function required(provider: StorageProvider, path: string): Promise<BinaryFileContent> {
  const file = await provider.readBinary(path);
  if (!file) throw new ConflictError(path, null);
  return file;
}

function remember(ctx: BinaryContext, path: string, p: string, t: string): void {
  ctx.snapshot.entries.set(path, { p, t });
  ctx.dirtySnapshot = true;
}
