# Mobile state and persistence

`WorkspaceRepository` owns a profile/workspace namespace. It is an actor: callers enqueue UTF-16
edit deltas or debounced snapshots after TextKit's input callback, then show “saved on iPhone”
only after the returned `LocalNote` acknowledges durability. Applying a returned snapshot to a
live editor also requires checking the editor revision; an asynchronous result is not permission
to replace newer typing.

## Durable files

Each profile UUID and hash of its workspace ID contains `index.sqlite` plus `markdown/`. Markdown
checkpoints are immutable UTF-8 `.md` files named by SHA-256. Working and base references may point
to the same checkpoint. Files are synchronized before a transaction publishes their references;
the index uses system SQLite, WAL and `synchronous=FULL`. Document and outbox changes commit in
one transaction with a generation comparison, so a second repository instance cannot overwrite
a stale generation. Text revisions and metadata generations are separate.

An interrupted checkpoint can leave an unreferenced markdown file; reopening uses only the last
committed references. Failed writes, invalid UTF-8, hash mismatches, unreadable protected files,
corrupt databases and unknown schema versions throw. They never produce empty writable notes or
rebuild over the damaged data. Checkpoints currently remain available until explicit future cache
management; there is no eviction of dirty content or merge bases. iOS files use protection until
first unlock. Tokens are not stored here.

## Reconciliation

`WorkspaceRemote` isolates transport. Its adapter must map a definite 404 to nil, a definite
conditional rejection to `WorkspaceRemoteError.conflict`, and attach the expected workspace ID
to every actual write. It returns the content/version acknowledged by that write. Its identity
response must come from an authenticated health handshake and advertise guarded conditional
writes. The repository verifies profile, origin, workspace and serving host before replay;
`invalidateConnection()` fences old asynchronous results.

`cache` seeds clean notes while retaining dirty/recovery entries. `refresh` removes clean remotely
deleted notes. `create` reserves a create-only draft; an existing path is a reviewable collision,
even when its words happen to match. `save`/`edit` compare the expected local revision. Replay
serializes writes and merges with the shared `TextMerge`; it never line-merges drawing files.
Same-line conflicts preserve the remote checkpoint and stop at review. `keepMergedEdits` resumes
only after explicit review. `useRemoteVersion` keeps the local checkpoint exportable. Deleted
dirty notes stop as recovery drafts; `recover(as:)` creates a separate note at a chosen new path.

Each outgoing attempt persists its exact body, base version, local revision and operation UUID
before the network call. The UUID is local bookkeeping, not a claim of server idempotency. A lost
response is reconciled by exact content/version. If the expected base still exists, replay is
safe; if the write's exact content exists, it is acknowledged without resending. If another
version has intervened, both sides remain available for review rather than replaying a potentially
already-applied task insertion. An acknowledgement changes only that attempt's revision and
base; later typing stays queued.

## Remaining integrations

This package provides text working copies and the repository policy, not the complete mobile
feature set. The app supplies lifecycle, guarded HTTP transport, editor checkpoint scheduling,
error/save-state presentation and explicit review UI. Atomic daily capture, drawing/asset
dependency ordering, cached search/threads/settings, cache budgets, structural online actions,
notification cursors and forget/export UI are separate integrations. Daily capture must not be
represented simultaneously as an append operation and an ordinary full-note save.

The storage protocols are injectable. Tests use real temporary SQLite/markdown files, a scripted
remote and injected disk/transaction failures; no real vault or daemon is accessed.
