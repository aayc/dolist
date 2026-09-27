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
`saveForReview` parks a conflict between uncheckpointed UIKit typing and a newly reconciled
snapshot, preserving the authoritative working/base copies before removing its queued save.
`createRecoveryDraft` retains typing that arrived while a clean cached note was remotely deleted;
it requires an absent path and never adds an outbox intent to recreate that path.

Each outgoing attempt persists its exact body, base version, local revision and operation UUID
before the network call. The UUID is local bookkeeping, not a claim of server idempotency. A lost
response is reconciled by exact content/version. If the expected base still exists, replay is
safe; if the write's exact content exists, it is acknowledged without resending. If another
version has intervened, both sides remain available for review rather than replaying a potentially
already-applied task insertion. An acknowledgement changes only that attempt's revision and
base; later typing stays queued.

## Workspace cache and composers

`WorkspaceCache` stores typed settings, the vault tree and recent thread summaries. Callers retain
the revision before fetching and pass it to `storeSettings`, `storeTree` or `storeRecentThreads`;
stale responses fail their comparison rather than replacing a newer snapshot. Missing cache
entries mean unavailable, never empty editable server data.

Composer drafts are durable strings keyed by `.thread(id)` or `.orchestrator`. `saveComposer`
requires the revision returned by `composer`. An explicit empty save clears the text but keeps
the revision, preventing a delayed pre-send checkpoint from restoring a sent/discarded draft.
These drafts never cause delayed automatic sends.

Notification cursor advancement, stable-ID deduplication and delivery acknowledgement use one
revisioned durable record. The caller supplies IDs from actual server notification decisions;
the cache does not infer `when_changed` from thread state. The visible list holds 500 entries and
the deduplication history 2,000. Cursor/revision checks reject stale pages.

The disposable metadata budget defaults to 8 MiB and removes oldest fetched payloads first.
Budget queries read indexed sizes rather than decoding large capture receipts. Composers,
notification state, captures, markdown, merge bases and recovery copies are protected. The
budget therefore bounds disposable metadata, not total protected user data. Completed capture
history stays durable, with the most recent 200 returned for display plus all pending/review
captures; replay reads only pending entries.

## Captures and write ordering

`CaptureOutbox.enqueue` freezes the operation UUID, text, phone-local Gregorian date, timestamp,
IANA timezone, profile/origin, workspace and serving host before returning a durable queue entry.
`CaptureRemote` maps that operation to the guarded append route; retries always send the same
payload to the same host. `RemoteWorkspaceIdentity.supportsAtomicCapture` must be true.

Sending state commits before the request. Lost responses and failed receipt commits remain in
that state after restart and resolve through the same server receipt. Applied receipts preserve
the original saved `DailyNoteResponse`; they are not a new fetch of the current note. Indeterminate
receipts stop replay and require `markReconciled` after explicit user review. Only queued,
never-attempted captures can be cancelled; their tombstones prevent reuse of that UUID.

Capture text stays outside note working copies until confirmed. SQLite barriers block new note
attempts while any capture is queued, sending or indeterminate. Capture preparation waits for
already-attempted note writes to resolve; those existing attempts may still reconcile/retry.
The app handles `pendingNoteWrites` by reconciling notes, then retrying captures, then ordinary
note synchronization. `pendingCaptures` is a waiting state, not a reason to erase edits. After an
ordinary synchronization pass, barred new writes remain waiting; persisted attempts are processed
first so lexical path order cannot deadlock capture. After an applied capture, refresh the current note and use ordinary three-way reconciliation. Never insert
a pending capture into the editor and also submit its full text as an ordinary note save.

Schema version 2 adds `workspace_values` to version 1 in one SQLite migration transaction. The
table holds revisioned payloads and indexed retention/size/write-barrier metadata. Existing note
and outbox rows remain intact. A failed migration rolls back; newer unknown versions fail closed.

## Online structural changes

`WorkspaceStructuralCoordinator.perform(.rename(from:to:isFolder:) / .trash(path:isFolder:),
with:)` verifies the same profile/origin/workspace/host, then persists a structural intent before
sending exactly once. `StructuralRemote` must use guarded online routes, verify the acknowledgement
matches the requested target, and use the daemon's soft-trash API. Map only definite no-effect
responses to `StructuralRemoteError.rejected`; timeouts, lost responses, ambiguous 5xx responses
and interruption all need review. No automatic structural resend exists.

Preparation atomically refuses affected dirty/review/recovery notes, affected note outbox records,
pending captures and any earlier unresolved structural intent. Folder membership requires an
exact path component boundary. Destination collisions are conservatively rejected across case,
Unicode normalization and file/directory prefixes. A durable barrier holds new note/capture sends
while structural state is unresolved; local typing still checkpoints. The app should checkpoint
and drain affected editors before invoking this API and fence editor sessions/navigation until
the result is known. Unrelated already-attempted note writes may finish.

A confirmed rename transaction remaps the latest cached paths and queued revisions, including
text typed while the request was pending. A confirmed trash removes clean cached records but
keeps newly dirty text as a recovery draft without an outbox. Recovery checkpoints are preserved.
Path-bearing disposable snapshots are invalidated. Capture dates, paths and host routing are
never remapped. The transaction either remaps everything or leaves every original row intact.

`unresolved()` enumerates persisted `attempting` and `needsReview` records, with operation UUID,
action/source/destination, scope, start time, revision and original checkpoint references.
After restart, `attempting` is uncertain: the process could have stopped before or after the host
mutated. Present both paths and refresh their existence/content plus relevant host/trash state.
Equal content alone is not proof of a rename. The user must explicitly establish whether the
requested mutation occurred; if evidence remains ambiguous, keep the record unresolved and
export its originals. `resolve(id, revision:as:with:)` revalidates identity and changes local
metadata only. It never sends the mutation again. `.applied` means the user confirmed the remote
mutation; `.notApplied` means the user confirmed no remote mutation. Both require the displayed
intent revision, and the app remaps open sessions only after an applied result.

A destination created locally during the network wait also stops at review. Export/copy that
local draft first, then use explicit `WorkspaceRecovery.discardLocalNote(path:expectedRevision:)`
if the user chooses to abandon that local record, and retry local-only resolution. Discard never
deletes remotely and refuses unacknowledged attempted writes. This prevents a collision from
forcing either silent overwrite or an unrecoverable blocked state.

## Recovery export and explicit forget

`WorkspaceRecovery.summary()` counts unsynced/review/recovery notes, unsent composers, unresolved
captures/structural actions and unknown protected records. `export(to:)` takes a consistent index
snapshot and writes working markdown, bases, attempted write bodies, recovery copies, composer
text, pending captures and structural originals. A versioned JSON manifest retains original
paths, hashes, revisions, routing and operation metadata. Only known content is exported; unknown
records are counted so the UI can report incomplete support rather than claiming a complete
export. Corrupt or missing referenced data fails instead of producing a falsely successful export.

Export files use numbered/hash flat names, so case/Unicode collisions and file-versus-directory
names cannot overwrite one another. Original paths are manifest data, never filesystem targets.
Each file is synchronized and the manifest is written last before the staging directory is
published. Failure removes staging and leaves the source untouched. Export is user-invoked,
contains no credential store or tokens, and may not target the private workspace directory.
The app owns security-scoped destination access and share/document-picker presentation.

`forget()` refuses protected local work. After offering sync or export, only an explicit discard
choice may call `forget(discardUnsyncedWork: true)`. The app first fences/cancels editors and
connection work, then invokes forget, and removes the Keychain credential/profile only after it
succeeds. A committed namespace tombstone fences existing SQLite handles and future ordinary
opens; forgotten work cannot reappear from stale callbacks. Checkpoint removal follows that
transaction and can be retried by a new recovery owner after a crash or filesystem error. Keep
the small tombstone database; pairing again uses a fresh profile UUID. This is ordinary local
data removal, not a claim of forensic secure erasure.
## Agent action receipts

`MobileAgentMutationJournal` implements AgentCore's optional `AgentMutationJournal`. Construct an
`HTTPAgentMutationRemote` from a verified `HTTPDaemonClient` with its immutable workspace guard,
then inject the journal into `AgentStore(client:mutationJournal:)`. The journal requires matching
workspace/host identity and `agent-mutations-v1`; an older host never falls back to an unguarded
phone action. Desktop callers without a journal keep their existing behavior.

The exact Codable command, stable operation ID and timestamp are committed before the first
request. A message uses its optimistic message ID as the operation ID. Commands cover chat,
thread stop/retry, approval decisions and routine create/run/pause/resume. Approval review is
checked again after preparation; a changed card, runner, expiry or authorization prevents sending.
This is an online action journal, with no background drain or automatic replay.

SQLite keys `agent-operation/<id>` hold version-1 records with `scope`, `intent` (ID, exact command,
creation date), optional confirmed `result`/server `receipt`, and `notDispatched` for a failed
authorization guard. `agent-operation-slot/<sha256 exclusion key>` holds the operation ID while
uncertain. Slot and intent preparation share a CAS transaction, preventing two open handles from
creating replacement IDs for one unresolved control. No credentials are stored in these records.
Unresolved rows and slots are durable, survive cache trimming and block namespace retirement.
Confirmation atomically removes the slot and makes history disposable; the daemon retains its
durable receipt even after that local history is evicted.

`AgentStore.pendingMutations` exposes unresolved intents, and `resolveMutation(id)` checks only
the saved receipt. Restart, cancellation, missing receipt, pending receipt and indeterminate
receipt never dispatch a saved command. The original HTTP result determines completion, including
rejections; receipt completion does not mean agent work has finished. Changed payloads cannot
reuse an ID. Repeated message attempts keep the original optimistic ID and pending messages
reappear when their thread loads. Global agent enable/disable remains the existing idempotent
settings operation.

The recovery exporter must either validate and export these typed pending commands or report
them as unsupported protected records; opaque journal JSON is never silently treated as an
exported draft. Explicitly forgetting unresolved actions loses their local recovery controls.

## Remaining integrations

This package provides text working copies and the repository policy, not the complete mobile
feature set. The app supplies lifecycle, guarded HTTP/capture transport, editor checkpoint
scheduling, error/save-state presentation, notification catch-up and explicit review UI.
Drawing/asset dependency ordering, cached search/full thread bodies/artifacts, clean markdown
cache eviction and structural/recovery UI remain separate integrations.

The storage protocols are injectable. Tests use real temporary SQLite/markdown files, a scripted
remote and injected disk/transaction failures; no real vault or daemon is accessed.
