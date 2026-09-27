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

## Durable drawings and dependent embeds

`DrawingRepository` shares the same namespace, immutable original/working/base markdown files,
document rows and outbox transactions, while ordinary `WorkspaceRepository` rejects and filters
`.excalidraw.md`. Its `cache`, `create`, `save`, `refresh`, `synchronize`, `recover`,
`useRemoteVersion` and `createRecoveryDraft` return `LocalDrawing` with the parsed document,
exact persisted content, durability/acknowledgement revisions and recovery file references.
Canvas input checkpoints call `save(path:scene:expectedRevision:)` after debounce; the actor owns
all serialization and disk work. Root UI must merge newer uncheckpointed canvas edits into an
arriving snapshot using the same scene model and fence stale editor sessions by path/revision.

The separate replay path uses shared `SceneMerge` by element ID/version/nonce, retaining deletion
tombstones and remote file sections. It never line-merges scene JSON. Unknown element types remain
verbatim while supported elements can change; dropping/changing an unsupported placeholder is
rejected. Unreadable, truncated, malformed or unsupported-version originals stay exact and
read-only with an editing error, not an invented empty writable scene. Invalid remote versions
encountered during local editing preserve both files and stop at `.invalidDrawing` review.
An unchanged canvas does not serialize/reformat a compressed original or create a write.

Conditional create/save, immutable attempts, lost response reconciliation, identity fences and
late acknowledgements follow the text repository's rules. A deleted dirty drawing becomes a
recovery draft without recreating its old path. `createRecoveryDraft` also retains canvas input
that arrived during a clean deletion refresh, including its previous non-scene file sections.
All drawing originals, bases and recovery copies participate in structural remaps and export.

For a newly inserted local drawing, first persist `DrawingRepository.create`, then persist the
note with `WorkspaceRepository.create/save(..., requiringDrawings: [drawingPath])`. SQLite
atomically records this dependency with the note revision and refuses its send until the drawing
has an acknowledged remote base. Dependencies carried by an immutable note attempt are cleared
only when that attempt is acknowledged; drawing dependencies added by later typing remain.
Structural changes refuse unresolved dependent embeds. Removing an unsent embed can explicitly
replace the note's dependency list. Do not infer a dependency from an untrusted remote wikilink.

Foreground replay should reconcile note and drawing attempts, replay captures, synchronize
drawings, then ordinary notes. Existing drawing attempts count as writes that captures must wait
for; new drawing attempts respect pending capture/structural barriers. `WorkspaceRemote` serves
both stores; no drawing-specific transport or unguarded write path is required.

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

Schema version 2 added `workspace_values` to version 1 in one SQLite migration transaction. The
table holds revisioned payloads and indexed retention/size/write-barrier metadata. Existing note
and outbox rows remain intact. Version 3 adds drawing rows/dependency semantics with optional
backward-readable JSON fields and advances the version atomically, so old writers fail closed
instead of bypassing a dependent embed. A failed migration rolls back; newer unknown versions
fail closed.

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
Binary asset upload/dependency ordering, cached search, clean markdown cache eviction and
structural/recovery UI remain separate integrations.

The storage protocols are injectable. Tests use real temporary SQLite/markdown files, a scripted
remote and injected disk/transaction failures; no real vault or daemon is accessed.

## Full thread and artifact cache

`WorkspaceContentCache` persists full `ThreadResponse` snapshots (messages, sources, artifact
metadata and the last observed approvals) and authenticated artifact bytes in the same scoped
SQLite database. Cached approvals are display-only; reading the cache never marks a thread read,
replays a message or grants action authority. The app constructs offline agent state from these
snapshots and separately establishes fresh connection authority before enabling actions.

Before a network fetch call `beginThreadFetch` or `beginArtifactFetch`. Store the response with
`storeThread(_:fetch:)` or `storeArtifact(_:data:mimeType:fetch:)`. Fetch tickets are persisted,
scoped and single-use. Starting a later fetch invalidates an earlier response; committing consumes
the ticket. Coalesce streaming checkpoints away from the main actor rather than persisting
every token. For an authoritative thread update after reducing buffered/live stream events, use
`beginThreadUpdate(_:replacing:)` with the current cached generation, then store the merged
snapshot. Do not store the earlier raw network response after merging events. A rejected ticket
means newer state/removal won, not an instruction to silently mint a replacement ticket for the
same old response. These rules survive process termination and multiple SQLite handles.

`thread`, `artifact` and `availability` distinguish absent bytes, an available snapshot and a
previous download above the current read limit. `entries(pinnedOnly:)` enumerates cache selections
without loading payloads.
Every snapshot includes `fetchedAt`, a monotonic generation and a SHA-256; freshness is presentation
information, never action permission. A cached thread lookup does not synthesize an empty thread.
`artifact` validates the exact bytes against the digest and their descriptor. MIME types describe
the server response, not trusted executable content; the existing preview/link policy still applies.
The cache rejects metadata/byte-size disagreement instead of accepting a truncated download.

Default ceilings are 64 MiB total, 8 MiB per thread and 5 MiB per artifact. The authenticated client
must also enforce the network limit while streaming (`artifact(..., maxBytes:)`), before these
bytes reach the cache. `ContentCacheLimits` can be supplied from phone preferences. Reads enforce
the current per-item ceiling before materializing bytes, even after lowering a limit. `usage`
counts payload, descriptor and metadata bytes; physical SQLite pages and its WAL add overhead.
`trim` evicts least-recently-accessed unpinned entries. Metadata, bytes and fetch invalidation are
one transaction, so an interrupted insertion or eviction cannot leave a successful empty cache.

`setPinned` records a chosen download even before its bytes arrive. `availability` then reports
missing and pinned. A pin is a cache preference, not unsynced work: it survives budget trimming but
does not prevent explicit workspace Forget. If pins exceed a lowered budget, `usage.overBudget`
remains true; the caller must offer unpinning or a larger budget. An insertion that cannot fit
without evicting pins fails atomically and preserves all prior cache data. `remove` is explicit,
clears the pin and fences any pending response. Dirty notes, immutable bases/recovery, capture
receipts, composers and pending actions never enter this cache and cannot be its eviction victims.

Schema 4 adds the content tables and nonreused workspace-value revisions. `commitValues` now returns
the actual revisions it committed; callers must use them rather than assume a recreated key starts
at 1. Existing revision values migrate unchanged. The revision history survives disposable-value
eviction, preventing an old response from passing CAS after deletion/recreation. Cache payload
failures report an unavailable/corrupt cache; repair must not alter durable note or operation state.

## Agent store cache adapter

`MobileAgentContentCache(rootDirectory:scope:limits:)` implements AgentCore's optional
`AgentContentCache`. It can also wrap an existing `WorkspaceContentCache` actor. Inject it into
`AgentStore(client:mutationJournal:contentCache:)`, hydrate with `hydrateCachedContent()` and
flush with `flushContentCache()` before suspension. Root app composition continues to own the
authenticated connection and workspace authority; the adapter never opens a network connection.
The Inbox uses the same bounded transactional content cache, so it shares eviction and retirement
semantics with full threads and artifacts. Opaque adapter ticket owners also reject tickets
accidentally passed to a different adapter instance.

Local notification catch-up reads `inbox()` and its `value.approvals`,
`value.approvalsFetchedAt` and `metadata.generation`. After a fresh pending-approval fetch, call
`replacePendingApprovals(_:replacing:)` with that exact generation (nil only for a missing
Inbox). It atomically preserves unrelated cached content and decided approvals, replaces the
pending set and timestamps the approval observation. A generation conflict requires reading and
reconciling newer state; it does not authorize blindly retrying an older response. Cached counts
and decisions are presentation data only. Notification IDs use `WorkspaceCache`'s separate
existing notification cursor, not the content entry's freshness timestamp.

## Checkpoint publication and reclamation coordination

Every synchronous note/drawing read or save holds `NoteCheckpointStore.beginAccess()` from the
index read through checkpoint creation and metadata commit. The Markdown implementation uses a
shared `flock` on a namespace file outside the markdown directory; independent actors, SQLite
handles and processes therefore share the same barrier. Network requests release it before
awaiting and acquire it again before reconciling their result. Injected wrappers around real
checkpoint stores must forward `beginAccess`, and index wrappers must forward
`lastDocumentRevision` along with ordinary metadata operations.

Cleanup takes nonblocking exclusive access and skips an active namespace. Export holds shared
access through copying its referenced markdown; explicit Forget holds exclusive access across
retirement and checkpoint deletion. The coordination file is never removed, including by Forget.
File-lock errors fail the operation; there is no uncoordinated fallback.

Schema 5 retains each path's highest editor revision and metadata generation after cache removal,
remote deletion, local discard and structural remaps. A later download or newly created draft at
that path gets a higher revision, preventing an earlier live editor from passing CAS after a
remove/recreate cycle. History is deleted only after namespace retirement fences every handle.

## Offline download controls and storage maintenance

`WorkspaceStorageMaintenance(rootDirectory:scope:budgetBytes:)` shares the repository namespace.
`inventory(protecting:)` reports present markdown checkpoints, byte usage, durable download
requests, selections and each document's eviction protections. The default disposable markdown
budget is 128 MiB; SQLite/WAL and the separate bounded artifact/attachment cache add overhead.
Presence is inexpensive metadata, while opening a note verifies its checkpoint digest and UTF-8.

`setPinned` accepts `.document`, boundary-aware `.folder` and `.allDocuments` selections, including
files not downloaded yet. `requestDownload(_:paths:maxBytes:)` persists the selection and fresh
per-path UUID requests from a fresh or explicitly labeled cached tree. `beginDownload` durably
records an attempt and returns a scope-bound ticket. These APIs never start a network request.
The app supplies authenticated streaming bounds, uses repository `refresh` to reconcile content,
and calls `completeDownload(_:expectedRevision:)` only for that exact durable revision. It must
not publish an old HTTP response with an arbitrary `cache` call. Completion checks the ticket,
current revision/generation, exact checkpoint digest and byte limit. `failDownload` preserves a
reason; cancellation fences completion, and a new request gets a new UUID. A persisted attempting
state after restart is unfinished work, not evidence of an active worker. An available request
records a past completion; `inventory.documents` is the current availability authority.

`trim(protecting:)` drops eligible least-recently-accessed clean index entries until the disposable
budget is met. `evict(_:protecting:)` requests particular clean paths. Both return skipped paths,
an active-writer busy result or unsupported durable-record counts rather than discarding work.
The UI must pass every live editor path, including typing not yet checkpointed. Pins, dirty notes,
immutable merge bases, review/recovery content, outstanding writes, structural recovery and drawing
dependencies remain protected even above budget. Generation CAS is repeated inside SQLite before
eviction, and revision history prevents stale editors saving through an evict/refetch cycle.

`collectGarbage(maximumFiles:)` separately deletes a bounded number of unreferenced hash-named
markdown files under the exclusive cross-handle publication lease. It derives references from
all notes, attempts and structural recovery records. Validated current capture/composer/journal
payloads contain inline data; any unknown durable format blocks reclamation. Symbolic links and
unrecognized files are untouched. Unlink or directory-sync failure cannot remove referenced
content; remaining orphans can be collected later. Download selections/progress live in separate
SQLite tables so disposable metadata trimming cannot remove them. Explicit workspace retirement
clears them along with the other namespace state.

## Durable attachment imports

`AttachmentUploadRepository(rootDirectory:scope:)` prepares file/photo bytes with
`prepare(data:originalFilename:)` and returns an `AttachmentUpload` only after one SQLite
transaction stores the exact original bytes and immutable operation metadata. Each upload gets a
random stable `attachments/<UUID>.<extension>` vault path; duplicate filenames do not collide.
The original filename is retained for export, never interpreted as a relative path. The raw-byte
limit is 5 MiB, enforced before persistence and by the authenticated HTTP transport. Markdown
extensions fall back to `.bin`; importing a note as editable markdown is a separate document flow.

`uploads`, `upload(_:)` and `bytes(_:)` expose persisted status and verified original bytes.
`HTTPAttachmentUploadRemote(client:scope:)` requires an immutable expected-workspace client and
advertised `binary-files-v1` capability. `synchronize(with:)` verifies profile/origin/workspace/host
before network access. It reads each fixed destination first and only issues a create-only upload
for a never-attempted queued operation. Lost replies reconcile by exact bytes. A previously
attempted file that is missing or different becomes `needsReview`; it is never silently recreated
or overwritten. Original bytes remain exportable. `cancel(_:expectedRevision:)` is explicit and
only available before any attempt. Review may be checked again safely; a deliberate re-import
uses `prepare` to produce a new path, and the editor must explicitly replace its old embed.

Pass returned `.dependency` values to note `create`/`save` as `requiringAttachments`. The editor
computes those dependencies off the input path and includes pending/review imports referenced by
its text. Existing acknowledged unrelated files need no dependency. Note attempt preparation
checks exact operation ID/path/hash acknowledgements inside the same SQLite transaction. Late note
acknowledgements clear only dependencies included in that immutable attempt, preserving newer
imports. An empty dependency array explicitly clears removed embeds; nil preserves the prior set.

New upload attempts share note/capture/structural barriers. Reconcile attempted uploads and notes
before captures, then send queued uploads after captures and synchronize notes again. A structural
operation affecting a pending import or note dependency is refused; local import preparation also
refuses an already-unresolved structural mutation. No connection or namespace can redirect frozen
routing. Call `invalidateConnection` on profile/connection changes; a late response then remains
unacknowledged and is reconciled by the next verified session.

Schema 6 rejects older writers which cannot enforce attachment dependencies. Metadata uses durable
`attachment-upload/<UUID>` workspace-value rows and raw originals use `attachment-original/<UUID>`.
Both row revisions are compared and committed atomically. Pending originals are durable; after
acknowledgement/cancellation only their bytes become disposable, while small typed metadata remains
available for late note dependencies. The separate content cache can keep acknowledged bytes for
preview. `RecoveryAttachmentUploads` validates exact key/scope/version/hash/byte count pairs and
provides pending originals to the recovery exporter; future or corrupt formats remain unrecognized
and protected. Markdown garbage collection recognizes these inline records and never deletes them.
