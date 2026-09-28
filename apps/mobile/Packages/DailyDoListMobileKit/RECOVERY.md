# Recovery exports and connection removal

`WorkspaceRecovery.export(to:)` publishes a complete recovery folder atomically. Format 3 contains
plain Markdown files, original attachment bytes with generated collision-safe names, and a `manifest.json`. Each file entry
records its original path/context, SHA-256 and byte count. The manifest preserves frozen capture
routing, typed attachment uploads, structural intents, and typed pending agent requests with their original operation IDs,
payloads, scope and storage revision. Agent requests are recovery evidence; importing or opening
an export must never replay them. Credentials are absent.

`agentOperations` recognizes only the current journal format with a matching exclusion slot.
Unknown, corrupt, orphaned or future records increase `unsupportedRecordCount`. The export still
preserves supported work, but cannot authorize removal while that count is nonzero.

Call `verifyExport(_:at:)` only with the completed destination returned by the Files document
picker. Cancellation or sheet dismissal is not completion. Verification reads back the copied
manifest and every referenced file, checks sizes and hashes, and rejects symbolic-link files or
the original temporary export directory. It returns an opaque `VerifiedRecoveryExport` bound to
the exact scope and snapshot. Verification streams file bytes rather than loading the whole
export into memory.

`forget(afterExport:)` verifies the copy again, takes the exclusive checkpoint-publication lease,
and compares the snapshot fingerprint inside the same SQLite immediate transaction that retires
the namespace. A note, drawing, composer, capture, structural operation or agent intent saved
through another handle after export invalidates the proof. The caller must export again. The
transaction fences all existing handles before deleting indexed state; checkpoint cleanup can
be retried after retirement. `forget()` without a proof refuses protected local work. The older
explicit-discard primitive is for deliberate maintenance callers and is not used by phone UI.

The app calls `PhoneWorkspace.prepareRecoveryExport()` before export and again after stopping
connection authority before removal. It finishes composition, checkpoints notes/drawings and
uses checked composer flushing. Any live text or scene that did not reach durable storage stops
the operation. The connection owner removes profile credentials and notifications only after
successful namespace retirement, and must account for every scope owned by that profile.

`PhoneForgetConnectionView` accepts `prepare` and `forget(scope, proof)` closures so the root owns
selection/connection lifecycle. A successful external copy enables removal; new local work still
fails the transaction even if the screen's earlier count was clean.

# Uncertain captures

`CaptureOutbox.inspectIndeterminate(_:replacing:with:)` verifies the original connection identity
and reads the receipt's exact note path without creating a daily note or retrying an append. Its
`CaptureInspection` is bound to the capture revision and connection generation. Missing notes are
shown as missing; matching text is never considered proof of the original append.

After explicit user review, `markReconciled(afterReview:)` removes the write barrier using CAS and
keeps the original capture in history. It never sends a replacement operation. A connection
change or another review invalidates the earlier inspection. The UI separately checks that its
workspace session still matches before presenting and accepting the evidence.
