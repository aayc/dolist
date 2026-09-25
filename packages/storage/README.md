# @ddl/storage

Vault storage behind the `StorageProvider` interface, a provider-agnostic two-way `SyncEngine`, and
vault search. Everything is plain text files addressed by vault-relative POSIX paths
(`Daily/2026-09-23.md`); see `src/types.ts` for the contract.

```ts
import { createStorageProvider, createSyncTarget, searchVault, SyncEngine } from "@ddl/storage";

const vault = await createStorageProvider({ kind: "local", root: vaultPath }, { logger });
const target = await createSyncTarget({ kind: "local", root: mirrorPath }, { logger });
if (target) new SyncEngine({ primary: vault, target, logger }).start();
const hits = await searchVault(vault, "groceries", { limit: 20 });
```

## Providers

| `kind`   | Class                     | Notes                                                    |
| -------- | ------------------------- | -------------------------------------------------------- |
| `local`  | `LocalFsStorageProvider`  | A folder on disk; the default vault. Obsidian-compatible. |
| `memory` | `MemoryStorageProvider`   | Reference model for tests and fixtures; acts like a disk. |
| `remote` | `RemoteStorageProvider`   | A vault on the sync service (`apps/sync`), for syncing devices. Sync target only. |
| `s3`     | `S3StorageProvider`       | **Stub**: every call throws `NotImplementedError`. The planned design is documented in `src/s3.ts`. |

Config shapes (`StorageConfig` / `SyncTargetConfig` in `src/types.ts`):

```ts
{ kind: "local", root: "/absolute/vault/path", ignore?: ["Archive/Old"] }
{ kind: "memory", id?: "fixture", initialFiles?: { "a.md": "…" } }
{ kind: "s3", bucket: "notes", prefix?: "vaults/personal/", region?, endpoint?, profile?, forcePathStyle? }
// sync targets: { kind: "none" } | { kind: "local", root } | { kind: "s3", …same as above }
//   | { kind: "remote", url, vault, token, deviceId, deviceName }
```

### Remote (the sync service)

- Talks to the sync service's HTTP API (`packages/core/src/sync-service.ts`) through
  `SyncServiceClient` (`src/remote-client.ts`): bearer token, the device id on every change, a
  timeout on every request, `Retry-After` on 429, typed errors. The token is never logged or put in
  an error message.
- Versions are the server's revs (identical content keeps its rev; a rename carries it along).
  `ifMatch` maps to the server's conditional writes and deletes; a stale one is a `ConflictError`
  with the current rev. Semantics match `MemoryStorageProvider`, which `remote.model.test.ts`
  checks command by command against a real in-process server, besides the shared contract suite.
- `watch()` holds a WebSocket to the vault's change stream while anyone listens: other devices'
  changes arrive as `self: false` events; this device's own changes were reported when it made
  them and aren't repeated. It reconnects with capped exponential backoff (0.5 s → 30 s, jitter)
  and then replays the net effect of what it missed from the change log.
- Created only through `createSyncTarget`. The design, the server and the agent lease are in
  [docs/SYNC.md](../../docs/SYNC.md).

### Local filesystem

- Creates the root if it is missing. Paths escaping the vault, lexically or through a symlink,
  throw `InvalidPathError`. Symlinked files inside the vault are followed; symlinked folders are
  not listed (to avoid duplicates and loops).
- Writes are atomic (temp file in the same folder, fsync, rename) and keep the file's permissions.
  `ifMatch` preconditions are checked against the disk under a per-path mutex, so check-and-write is
  race-free within one provider instance, whatever spelling of the path callers use.
- On case- or normalization-insensitive disks (macOS), `notes/A.md` and `Notes/a.md` (or NFC and
  NFD `Café`) are one file; results and events report the disk's spelling, like listings. Names
  longer than the file system allows throw `InvalidPathError`. Files that can't be read are
  skipped when listing; symlink loops behave like dangling links (missing).
- Versions are content hashes (`contentVersion`), memoized by (path, mtime, size), so listing an
  unchanged vault doesn't re-read files. Binary formats (images, PDFs, …) and files over 16 MiB are
  versioned by stat instead.
- `.git`, `node_modules`, `.trash`, `.DS_Store`, editor temp files (`*~`, `*.swp`, …) and the
  provider's own `.ddl-tmp-*` files are never listed or watched. `ignore` adds path prefixes.
- `watch()` starts a recursive `fs.watch` on first subscription and stops it after the last
  unsubscribe. Own writes, deletes and renames emit `self: true` events synchronously, and their
  echo from the OS is suppressed. External changes emit `self: false` after a per-path debounce
  (`watchDebounceMs`, default 50 ms). Touches that don't change content emit nothing, and an
  editor's save-via-temp-file becomes a single `modified`. A folder that is deleted or moved in
  produces events for each file inside it. The watcher restarts with backoff after errors and then
  rescans the vault. `whenWatchReady()` resolves once the initial scan is done.

## Sync

`SyncEngine` syncs a primary provider (the vault) with a target provider in both directions.

- `syncOnce()` runs a full pass. Runs never overlap: calls made during a run share one follow-up
  run. `start({ intervalMs = 30000, debounceMs = 1500, targetDebounceMs = 250 })` syncs
  immediately, then after vault changes (debounced), after changes the target reports that it
  didn't make itself (another device, another app; its own `self` echoes are ignored), and on the
  interval. `stop()` waits for an in-flight run. `status()` and `onStatus()` report
  `idle | syncing | error`, `lastSyncedAt`, `pendingChanges` and open conflict copies (including
  ones another device made and this one pulled). Use `disabledSyncStatus()` when no target is
  configured.
- The last synced state is stored in the vault at `.daily-do-list/sync/<target.id>.json`. For each
  path it records both sides' versions, plus the content of text files up to 256 KiB as the merge
  base. Each device keeps its own snapshot, and the snapshot itself is never synced.

Per path, compared with that snapshot:

| Vault          | Target         | Result                                                        |
| -------------- | -------------- | ------------------------------------------------------------- |
| unchanged      | unchanged      | nothing                                                       |
| changed        | unchanged      | copied to the target (`pushed`)                               |
| unchanged      | changed        | copied to the vault (`pulled`)                                |
| deleted        | unchanged      | deleted on the target (`deletedRemote`)                       |
| unchanged      | deleted        | deleted in the vault (`deletedLocal`)                         |
| deleted        | changed        | the changed file is restored (never lose an edit)             |
| changed        | changed        | identical: nothing to do; otherwise merged or conflict copy (see below) |
| new            | new            | identical: nothing to do; otherwise conflict copy             |

**Conflict policy.** Markdown/text (`.md`, `.markdown`, `.txt`) gets a line-based three-way merge
(`diff3`) against the stored base. Edits to different lines merge cleanly, including adjacent
lines. When both sides add lines at the same spot, both additions are kept (vault first). If the
merge still conflicts, the vault's version wins everywhere and the target's version is saved as
`<name> (conflict YYYY-MM-DD HHmm).<ext>` on both sides. The agent's append-only journals
(`.daily-do-list/state/journal/**.jsonl`, `isJournalPath`) are merged as the union of both copies'
lines by event id, ordered by `(epoch, seq, id)` (`mergeJournals`): the result depends only on the
set of lines, so every device ends with the same bytes, and there is never a conflict copy. With a
lease fence, only the holder pushes them (as the union when the target's copy changed too); others
take the target's copy. Other formats (JSON, `.canvas`, …) keep the version with the newest mtime, and the other becomes the
conflict copy. Nothing is ever silently dropped.

**Appends.** `StorageProvider.append` (optional; local-fs and memory have it, `appendToFile` falls
back to a conditional read and write) adds text at the end of a file without rewriting it; it is
not atomic, so a crash can cut the appended text short. Local-fs versions journals by stat, so an
append never re-reads or re-hashes the file it grows.

**Safety.** All writes are conditional on the versions seen during the run. A concurrent edit makes
a write fail with `ConflictError`, and that path is retried on the next run. Without a snapshot
entry, files are never deleted. If one side lists no files at all (for example an unmounted drive
or an unsynced cloud folder) and that would delete synced files the other side still has
unchanged, the run fails with `SyncAbortedError` instead. Evicted iCloud Drive files
(`.name.icloud` placeholders) are treated as unavailable, not as deletions.

**Never synced:** `.daily-do-list/sync/**`, temp and editor backup files, ignored names, binary
formats (the provider API is text-only), and any `exclude` prefixes you pass.

**Limitations.** Binary attachments are not synced until the contract grows a bytes API. File
names that differ only in case or Unicode normalization between two file systems are not
reconciled and stay pending. The target must not be inside the vault (or the reverse).

## Search

`searchVault(provider, query, { limit = 50, includeHidden = false, maxFileBytes = 1_000_000 })`
runs a case-insensitive substring search over markdown files. Note-name matches come first
(`line: 0`, preview = path; queries containing `/` match the whole path). Then come matching lines
(0-based `line`), most recently modified notes first, each with a ~160-character preview centred
on the match.

## Adding a provider (S3 is next)

1. Implement `StorageProvider` in `src/<name>.ts`. Keep the semantics of `MemoryStorageProvider`:
   normalized paths (empty ones are invalid), `ConflictError`/`NotFoundError`, opaque versions,
   `self` events for own changes, folders that outlive their files, no file and folder sharing a
   path, and junk/temp names that are never listed. `model-based.test.ts` checks `local` against
   it command by command; do the same for a new provider.
2. Add a `kind` to `StorageProviderKind` and a config shape, then map it in `createStorageProvider`
   (and in `createSyncTarget` if it can be a sync target).
3. Run the shared contract suite from a test file:

   ```ts
   import { describeStorageContract } from "@ddl/storage/contract-suite";
   describeStorageContract("MyProvider", async () => ({ provider: await makeEmptyProvider() }));
   ```

4. Add provider-specific tests (the `LocalFsStorageProvider` tests are a template) and document the
   config above. For S3, the suite can run against MinIO in CI. Unit tests must not hit the network.
