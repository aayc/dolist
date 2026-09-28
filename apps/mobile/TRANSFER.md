# Native iPhone app — transfer handoff

Status as of 2026-09-27. This is a transfer snapshot, not a release announcement.

**The app is substantially implemented, builds, and has passed broad automated tests and several
real simulator journeys. It is not finished or fully accepted.** Confirmed defects, unintegrated
work, and a large computer-use acceptance matrix remain. Continue from the existing implementation;
do not restart it or replace it with a prototype.

## 0. Update: every section 6 stream integrated (2026-09-27, evening)

A second agent continued from this document. Sections 1–12 below are the original snapshot;
where they disagree, this section wins. Still no iPhone Vim of any kind.

- **Integrated on `codex/iphone-app`** (tip `eba709e` plus documentation): bounded search
  (`586e150` only, as `b1432b8`), strict storage protection and its app lifecycle (6A), drawing
  import safety and the protected shape library (6D), recovery-export staging and retirement
  ordering (6E), and the lead's download, keyboard and editor fixes (6C, 6F).
- **6A:** protection is created before any store, and startup and cold intents wait for it.
  A live change saves all work or refuses; it awaits background work, releases every
  workspace, requires zero open handles or shows a retry state, then recreates and reconnects.
  App-owned files use `MobileProtectedFile` (see `PROTECTION.md`).
- **6C:** note and drawing repositories run one network pass at a time (`RepositoryPasses`).
  A refresh no longer returns a cached copy as fresh, and a sync no longer drops pending edits
  while another pass runs. That second bug was not in the list above. A resumed download
  publishes its new request id before reading. Downloaded pinned files whose host version
  changed are queued again. Launch and tree refreshes list documents from metadata.
- **6D:** photo and file loads are bound to their request, and imports are checked against the
  daemon's exact 5 MiB write body. The library moved from UserDefaults to a protected file,
  and the old copy is removed only after the new one reads back.
- **6E:** exports stage in locked, app-owned containers that are cleaned after cancel,
  verification or restart. A retired profile is removed only as the last step.
- **6F:** hardware Tab/Shift-Tab indent and outdent. Hidden note editors are released once saved.
  Links: the user chose web and Mac's rule for every client. The phone (links, embeds, previews)
  and the shared backlink index now resolve vault-wide (the exact path, else the shortest with
  that name) and strip `|alias` like the Mac; the same-folder exact-path preference is gone.
- **Verification:** 228/228 native tests, 133 MobileKit, the unsigned device build and
  `pnpm check` pass, as do CI, Security, Linux bundle and every macOS job except one. That job,
  the Mac app's own tests, intermittently crashes on an unowned reference read after its object
  was freed (seen before this session too; not reproducible locally in five full runs).
  Two desktop Vim timers that could do that were fixed, but the crash recurred, so its source
  is still unknown. Failing Swift jobs now upload crash reports. A noisy Vim p99 test was fixed.
- **CI:** the iPhone job caches its DerivedData, skips coverage and the index store, builds for
  a device only on `main`, and boots the simulator during the build. A branch skips iPhone
  sources that already passed. Superseded caches are pruned (the repository was over its
  10 GB limit), the redundant iOS package build is gone, and one redundant UI test is dropped.
  A full iPhone run still takes 8–14 minutes (runner speed varies; most of it is the
  simulator's first boot), but it skips in 15 seconds when its sources already passed, so the
  whole macOS workflow then finishes in about 3 minutes. See `docs/CI.md`.
- **Computer use (QA simulator, synthetic host):** passed an upgrade over old data (protection
  migration, restored note, Synced); typing, Backspace, save and sync; image from a table cell
  lands after the whole table, with byte-identical upload and preview (the transfer's recheck);
  content search at the correct 1-based line; hardware Tab indenting on the host. Shift-Tab
  needs modifier keys, which Cursor's computer use drops, so the real-typing UI test presses it
  with XCTest's keyboard. Its taps on text go through accessibility and can't place a caret, so
  journeys use buttons, search results and plain keys; bring the Simulator to the front first.
- **Found by computer use and fixed:** a live protection change never drained, because the
  keyboard command controller held the workspace strongly (`d4b9b03`). A harmless inbox race
  showed "WorkspaceContentCacheError error 3" (same commit).
- **Open defect:** a live protection change started from Settings still can't drain: the
  released `PhoneWorkspace` stays alive, attributed to SwiftUI's attribute graph plus a holder
  `leaks` can't name (the simulator process isn't debuggable). The change stays pending and
  completes before storage opens on the next launch (verified both ways); Retry from the failure
  screen is unreliable. Nothing is lost. Next: build a debuggable app (Xcode's debug signing)
  and read the memory graph, or close released workspaces' stores explicitly after quiesce.
  Also: after a successful change the start screen flashes "Offline" for a few seconds.
- **Not done:** the rest of the section 9 matrix. Physical-device checks (section 11) are
  unchanged. The QA fixture now also has two list lines for Tab and the imported image.

## 1. User intent and transfer boundary

The user originally requested a plan, then explicitly authorized complete native iPhone
implementation, all required tests, and thorough computer-use verification of every feature while
away for several days. They authorized multiple subagents and asked for faster progress. They have
a **free Apple account**, not paid Apple Developer enrollment.

The user explicitly said **“don't do vim mode in iphone at all.”** No mobile Vim, vimrc UI, or Vim
acceptance work is authorized. Existing Mac/web Vim must remain intact. A historical mobile-Vim
worktree exists; do not integrate it.

The latest instruction is to produce this document and transfer implementation to another agent.
New feature work in this task has stopped. Subagents were asked to preserve their work and report
its state. The hourly continuation automation `finish-native-iphone-app` has been **paused** to
prevent two agents from continuing the same implementation. Do not mark the application complete.
The task's persisted goal was already usage-limited; the handoff documents, not that goal status,
are the source of implementation truth.

Read these first:

1. Root `AGENTS.md` — repository conventions, safety, tests and public-repository rules.
2. This document — current transfer snapshot and priority order.
3. `apps/mobile/PLAN.md` — complete required feature scope, milestones and acceptance design.
4. `apps/mobile/IMPLEMENTATION.md` — chronological implementation and verification evidence.
5. Root `PROGRESS.md` — public cross-machine handoff.
6. `docs/specs/iphone-implementation-streams.md` — original parallel ownership boundaries.

Older entries in `IMPLEMENTATION.md` describe work as pending that later entries complete. Prefer
this snapshot and the newest evidence over old status paragraphs. The original plan also contains
historical “not implemented today” statements; those are planning context, not a current inventory.

## 2. Source of truth, branches and publication

| Item | State at transfer |
| --- | --- |
| Integrated implementation branch | `codex/iphone-app` |
| Latest integrated code checkpoint | `79e928f1b86218e48c1e530351fcea8b21f2ad76` — pushed |
| Main handoff checkpoint before this document | `2f5fdb4` — pushed |
| Root implementation worktree | Named `dolist-iphone-app`; exact local paths are in the private annex |
| Root working tree at the transfer request | Clean; documentation added afterward |
| Integration into main | Not done; do not merge merely because most code exists |
| Last completely green four-workflow checkpoint | `cebe37c` |

The latest code checkpoint includes all previously integrated attachment/content/command work.
Do not cherry-pick historical stream commits again. Recent root integration commits include:

- `eba5728`: durable-checkpoint guards before destructive note/drawing/structural changes.
- `1346a03`: native modal ownership guards for global hardware shortcuts.
- `79e928f`: native content lifecycle, bounded note transport, attachment import/dependencies,
  downloads/storage UI, backlinks, safe link previews, activity highlights, drawing-element
  navigation, profile-selection safety, and associated regressions.

All development and tests use isolated worktrees, synthetic vaults and test daemons. Preserve the
installed Mac app, its real vault, and its daemon. Never bind or kill ports **7331** or **5173**.
Never inspect or publish real API keys, pairing credentials, personal notes or browser profiles.
Do not commit absolute paths containing a username. The local operational annex is intentionally
untracked and must not be added to this public repository.

## 3. Architecture and where to work

The iPhone is a native SwiftUI/UIKit client of the authenticated daemon. It does not run the agent
orchestrator locally and must not bypass its safety gate. It preserves offline work locally and
syncs it to the exact paired workspace/host when authority is re-established.

| Layer | Main implementation |
| --- | --- |
| App shell and composition | `apps/mobile/Sources/DailyDoListMobile` |
| Connection, pairing, Keychain | `DailyDoListMobileKit/Connection`, `PhoneAppModel`, `ConnectionView` |
| Offline persistence | `DailyDoListMobileKit/Repository`, `Maintenance`, `Captures`, attachment/content-cache code |
| Open editor sessions | `Workspace/NoteSession.swift`, `DrawingSession.swift`, `PhoneWorkspace` extensions |
| Native text editor | `apps/macos/Packages/DailyDoListEditor/Sources/DailyDoListMobileEditor` |
| Shared text logic | `DailyDoListEditorCore` — tokenizer, edits, source mapping, content index, badges, links |
| Native drawing canvas | `DailyDoListMobileDrawing`; portable engine in `DailyDoListDrawingCore` |
| Agent UI/state | `DailyDoListMobileAgent`, `DailyDoListAgentCore` in the shared Agent package |
| Settings/hosts | Shared native mobile settings package plus phone-specific settings views |
| Phone integrations | `DailyDoListMobileIntegration` — App Intents, local alerts, catch-up, background refresh |
| Transport/protocol | `DailyDoListClient`, `DailyDoListModels`, TypeScript contract schemas and daemon |

Important implementation choices and invariants:

- iOS 17 minimum; XcodeGen project with free-account-compatible capabilities.
- Explicit TextKit 1 editor. UIKit input, marked text, selection, undo and overlays remain native.
- Markdown source remains ordinary text. Preview widgets must not rewrite the user's words.
- Input work remains proportional to the edited line. Parsing, dependency discovery, checkpoints,
  search and network work do not run synchronously per keystroke.
- SQLite indexes plus immutable Markdown checkpoints retain working copies, merge bases, pending
  operations, recovery records, captures, content caches and upload originals.
- Writes are conditional and scoped to profile/workspace/host/origin. Connection generations reject
  late responses. A changed workspace at the same endpoint must not receive old drafts.
- Uncertain actions use durable receipt IDs and reconciliation. Do not implement blind retries.
- Upload dependencies prevent notes from reaching the host before newly referenced attachments or
  drawings. Cancelled/uncertain originals remain recoverable; they are not silently recreated.
- Daily dates come from the phone's local calendar. Offline captures retain their original date.
- Host deletes are soft deletes. Recovery/Forget is an explicit local operation with verified export
  and revision checks when protected work exists.

## 4. What is implemented and working well

“Implemented” below does not mean every feature has completed computer-use acceptance.

### Connection and durability

Manual/QR connection UI, saved profiles, Keychain tokens, pairing/re-pairing, authenticated
connections, workspace identity checks, reconnect and offline hydration are implemented. Real
HTTPS pairing and real simulator Keychain persistence have been exercised. Simulator signing was
corrected after CUA exposed a missing Keychain identity.

Notes checkpoint locally before sync. Offline edits survive process termination and relaunch.
Reconnection preserves disjoint phone/host edits. Overlapping edits retain originals for review.
Native tests cover live typing, incoming revisions, marked-text composition, deleted host notes,
and malformed incoming drawing files. Disk-full failures now prevent destructive review or
structural actions from replacing unsaved live text/scenes.

Profile-construction failure no longer leaves an old editor visible under a newly selected
connection. A regression verifies that the previous draft remains durable, selected-profile
defaults are not rerouted, and the failed profile does not start a network connection.

### Notes and native editor

Today, daily/weekly navigation, tomorrow/date selection, ordinary note creation, hierarchical
explorer, search, recents, tabs, back/forward, restoration, rename/trash and recovery views are
implemented. Offline periodic creation uses cached settings/templates and refuses a missing
configured template instead of creating a misleading blank replacement.

The editor supports Markdown live preview/source mode, read-only mode, native typing/selection,
task continuation and checkboxes, formatting and undo/redo. Native tables provide source-row
editing; callouts are typed and foldable; backlinks show linked and unlinked mentions with context.
Agent badges, prose highlights, current/other-note activity indication and safe note/citation
preview sheets are composed.

Two CUA-discovered regressions were fixed: native overlay controls no longer lose taps to their
hidden Markdown links, and image insertion from a table cell goes after the complete table rather
than between its rows. Hidden source inside a rendered content block cannot also paint a second
attachment preview. Exact attachment replacement preserves captions, titles and surrounding syntax.

### Drawings and attachments

The shared native drawing engine, touch canvas, tools/properties, arrangement, point/frame/grid
controls, images, clipboard/library, SVG transfer and undo/redo are implemented. Standalone and
inline drawing sessions use durable scene persistence and element-wise conflict merging. Remote
changes defer during active gestures. Drawing links now retain `#^element` and focus that element
after the canvas mounts; a native regression covers this.

Binary storage and sync preserve original bytes. Authenticated file endpoints and Swift streamed
downloads are bounded. Inline images/PDFs use safe static previews. Files/Photos import, attachment
review/cancel/export/replacement and durable upload dependencies are composed. A 5 MiB per-file
limit and 32 MiB retained-original budget protect the attachment outbox. A Photos import was
verified byte for byte against the original synthetic PNG.

Downloads/pins, selected folder/all-note requests, budgets, retry/cancel and safe cleanup are
implemented. Open editors, unsent work, recovery copies and pins are protected from disposable
cache eviction. Some freshness/cancellation integration defects remain in section 6.

### Agent workspace and phone integrations

Inbox, threads, routines, approvals, artifacts, browser/computer live views, host/shared settings
and host-management controls are implemented using shared agent logic. Durable composers and
receipt-aware mutations preserve uncertain outcomes. Offline Inbox/thread/artifact snapshots
hydrate before connecting; action buttons remain disabled until fresh host authority returns.

App Intents/Shortcuts expose add task, open Today and show/count approvals. App-target metadata
contains the action phrases and explicit local-device authentication. Local notification catch-up,
deduplication, generic previews by default, exact route scoping, visible-thread suppression,
optional background scheduling and app-switcher privacy protection are composed. These are local
alerts/catch-up, not an always-on phone or APNs delivery guarantee.

The command palette, Quick Open, search modes and hardware command routing are implemented without
Vim. UIKit ownership guards prevent global commands from opening over unrelated sheets or nested
pickers. Repeat CUA confirmed Quick Open still works and Cmd-N remains blocked in Backlinks.

## 5. Verification evidence and its limits

### Latest integrated checkpoint

| Check | Result |
| --- | --- |
| Full iPhone simulator suite | Passed on the working tree committed as `79e928f`: 194 tests, 228 parameterized executions, zero failures/skips |
| Shared Mac Editor package | All 309 tests passed, including shared content/tokenizer and existing Vim behavior |
| Full repository `pnpm check` | Passed with `TURBO_CONCURRENCY=1`; lint, typecheck, unit tests and secret scan |
| Focused bounded authenticated note transport | Six tests passed |
| Shared content/backlink parsing | Seven focused tests passed before the latest broad editor run |
| Recovery checkpoint failure regression | Four native cases passed and are included in the integrated suite |
| Hardware modal ownership | Native UIKit presentation regression passed; actual Backlinks/Cmd-N CUA also passed |
| Device SDK build | Unsigned device SDK builds have passed repeatedly; the last local one preceded the final element-link additions, so repeat at final tip |
| Physical iPhone | Not verified; do not equate simulator/device-SDK compilation with device execution |

The exact local logs and latest `.xcresult` path are in the private annex. Do not claim that a test
on an isolated stream validates final app composition unless the root reran it after integration.

### CI at the transfer snapshot

All four required workflows passed on `cebe37c`. New runs target `79e928f`:

- [CI](https://github.com/aayc/dolist/actions/runs/36360961303): passed when checked.
- [macOS app / iPhone / shared iOS](https://github.com/aayc/dolist/actions/runs/36360963489): in progress when checked.
- [Security](https://github.com/aayc/dolist/actions/runs/36360965235): passed when checked.
- [Linux bundle](https://github.com/aayc/dolist/actions/runs/36360966718): passed when checked.

Refresh these statuses before deciding release readiness. Dispatch workflows manually if branch
pushes do not trigger them. The final integrated tip needs the full required gate set.

One local Mac window-opening benchmark fails around 6.4 seconds against a 1-second budget. An
isolated unchanged baseline reproduced approximately the same result, while CI passes. This was
not treated as an iPhone extraction regression, and the budget was not widened. Keep the evidence
and investigate if final CI or a comparable environment also fails.

### Computer-use journeys actually exercised

| Journey | Observed result |
| --- | --- |
| Manual HTTPS pairing and launch | Connected to an isolated mock host with real simulator Keychain persistence |
| Checkbox/prose/emoji/Return | Real input worked after fixing tap interception and disappearing emoji glyphs |
| Task → Inbox → mock thread/artifact | Result, unread state and Markdown artifact displayed; portrait/landscape checked |
| Capture | Host received the captured task exactly once in the exercised scenario |
| Offline edit → terminate/relaunch → reconnect | Local draft survived; disjoint remote edit merged; final status Synced |
| Note creation/search/history/restoration | Correct content/line navigation, selected note and Back restored |
| Theme/rename/trash | Host acknowledged theme; renamed note; deleted text verified in synthetic host Trash |
| Standalone drawing text/save/undo/redo | Passed; offline drawing edits survived relaunch and disjoint remote shape merge |
| Drawing embed insert/menu/Edit here | Passed; hidden-source touch interception corrected |
| Drawing rectangle drag | CUA discrepancy remains; real-touch standalone and inline XCUITests pass |
| Offline Inbox/thread/artifact | Cached content visible, mutation controls disabled, missing artifact honestly labeled |
| Offline Tomorrow/template failure | Cached daily template worked; missing configured weekly template produced an explanation |
| Notifications | Consent/private defaults/privacy shield checked; exact local alert opened correct thread |
| Mock approval | Exact input reviewed; Approve once acknowledged by host and mock task completed; no real purchase |
| Table/callout/backlinks | Table edit and Undo preserved Markdown; callout unfolded; two linked and one unlinked mention shown at correct human lines |
| Photos import | Synthetic PNG preserved byte for byte; table insertion defect found and fixed in code/tests |
| Quick Open and modal commands | Cmd-O search/Return passed; Cmd-N did not open a new sheet over Backlinks after the fix |

The final attempted table-import recheck did **not** finish. The QA fixture was being reset when
the user requested this transfer. Do not count it as a new import pass. A simulator clipboard
handoff failed and pasted stale clipboard contents; that paste was explicitly undone. The current
synthetic content fixture needs reseeding before the next table/callout test. This is an automation
pitfall, not evidence that source pasting through the app has been validated.

## 6. Confirmed unfinished work and problems

### A. Integrate strict storage protection and prove the lifecycle — done (section 0)

`codex/iphone-protection`, commit **`22d1f60`**, is pushed but **not integrated** into the root app.
It implements durable pending/committed protection policy, Keychain accessibility migration,
existing/new checkpoint/profile/SQLite protection, locked-access gating, and protected recovery
staging. It contains its own tests and integration instructions in
`apps/mobile/Packages/DailyDoListMobileIntegration/PROTECTION.md`.

The hard part still belongs to app composition:

1. Create `PhoneProtectionMigration` before stores using the existing root and Keychain owner.
2. Own `PhoneStorageProtectionController` and await preparation before profiles/workspaces/network
   or cold App Intents. Use actual readiness/mode for background policy, not the old Boolean setting.
3. Checkpoint all sessions and composers; refuse migration if any live state cannot be saved.
4. Stop and **await** download/sync/notification/background tasks. Cancellation alone is insufficient.
5. Remove workspace views and release every repository/cache/recovery handle before migration.
   SwiftUI navigation/settings views can still retain an old workspace after the model clears it.
6. Use `migration.storage.openAccessCount` to confirm handles drained. If not, fail safely with a
   retry UI. Never force-close a DB, erase a namespace or discard live state to make migration pass.
7. Recreate/rehydrate the selected workspace and reconnect only after success. Exercise startup,
   interrupted migration, retry, background/cold intent and failed-checkpoint paths.

The stream passed 123 MobileKit tests, 18 Integration tests, and 22 native tests / 25 parameterized
executions. Native Keychain class migration was verified. iOS Simulator omits `NSFileProtectionKey`,
so actual file-protection class and lock-encryption assertions remain physical-device checks.

### B. Bound offline search and backlinks before loading content — done (section 0)

At `79e928f`, callers use `repository.notes()` before enforcing their result/byte limits. That
eagerly materializes all checkpoint content and defeats the intended large-vault memory bound.
An independent fix is pushed as `586e150` but is not integrated; see section 7 and the final addendum.

The new design uses metadata-only listings plus incremental bounded working-text reads, checking
file length before allocation and keeping dirty local content ahead of disposable cached content.
Search/backlinks must explicitly disclose incomplete coverage. Root must compose and retest it.

### C. Fix remaining download races and freshness — done (section 0)

Three specific issues still need resolution:

- Resuming `.attempting` creates a new download ticket UUID, but the UI inventory is refreshed only
  after the network read. Cancel during that read submits the old UUID and gets `staleDownload`.
  Publish the new request identity immediately after `beginDownload`.
- Note/drawing `refresh` currently returns the cached row if another synchronization holds the
  repository-wide synchronizing flag. A download can therefore label stale cached A “available”
  while an unrelated B sync is running. Require a proven fresh read, a busy outcome, or explicit
  serialization. Add a held-B-sync/A-download regression.
- Newly added pinned paths are queued, but already completed closed pinned notes are not
  automatically refreshed when the authenticated tree reports a new version. Use metadata-only
  `baseVersion` comparisons and preserve cancellation/retry semantics.

A previous defect where explicit retries skipped already cached notes was fixed. That fix does
not resolve the concurrent synchronization case above.

### D. Make drawing imports safe under races and upload limits — done (section 0)

The drawing import stream is unfinished/unintegrated:

- Photos tasks read mutable replacement selection after awaiting the picker. A later selection
  can cause the first load to replace the wrong element. Freeze target/generation, cancel superseded
  loads and recheck edit authority before commit.
- Embedded drawing images permit much larger payloads than the daemon's 5 MiB note request body.
  A 4 MiB PNG becomes more than 5 MiB after base64/JSON encoding. Repeated imports/replacements can
  also cross the limit. Preflight the **exact serialized write request** before committing imports,
  paste, or library changes; refusal must preserve scene, selection, history and original bytes.
- The shared drawing library stores serialized shapes/images in UserDefaults, outside the managed
  protection root. Move it behind protected persistence and migrate legacy bytes only after a
  verified successful save. Preserve the old copy on failure.

The planned app hook is `controller.importContext`, supplied by `DrawingSession` with its current
drawing document and base version. Scene-only validation cannot account for preserved Markdown
frontmatter/sections. Confirm the stream's final API before wiring it.

### E. Finish recovery/Forget cleanup — done (section 0)

At `79e928f`, interrupted retirement is recognized and resumed, and the notification badge is
cleared. Two remaining concrete gaps were found:

- `finishRetiredConnection` removes the profile before notifications/default selection. A crash
  after profile removal leaves no profile to enumerate on restart. Clean scoped alerts/defaults
  first; keep the retired profile until remaining cleanup has succeeded.
- App-owned temporary recovery exports can retain full unsynced originals after verified Forget,
  cancellation or repeated exports. Add owned staging cleanup on completion/cancel and restart.
  Never delete the user's chosen Files destination. Both `PhoneForgetConnectionView` and
  `PhoneRecoveryView` need the staging abstraction.

An export-cleanup stream was preparing this work when transfer was requested; see section 7.
The export proof/revision checks must remain intact. Do not reduce Forget to an unconditional delete.

### F. Keyboard, editor retention and remaining parity review — done except CUA (section 0)

- Physical Tab/Shift-Tab are not yet routed through the shared indent/outdent commands. Touch/menu
  indentation works. Add native handlers that respect IME composition and read-only state.
- Replaced/closed clean editor sessions can remain retained longer than necessary. Besides memory
  use, this can protect too many cache entries from cleanup. Prune only after durable checkpoint,
  preserving failed saves, navigation state and inline drawing owners.
- Review relative same-folder wikilink resolution where the extension is omitted; the current
  helper prefers exact relative paths then shared wiki resolution. Do not silently resolve a
  different same-named note when local-folder semantics should win.
- Living-list highlights/header and link preview sheets have implementation/unit coverage, but
  their full live CUA interactions have not been completed.

## 7. Work outside the integrated branch — all integrated (section 0)

The following is a snapshot of parallel work, not permission to blindly merge whole branches.
Subagents may have snapshot commits containing copied root files. Only integrate their actual
feature delta; preserve root's later drawing-focus, retirement and attachment composition changes.

| Stream | Transfer state |
| --- | --- |
| Strict storage protection | `codex/iphone-protection`, `22d1f60`, pushed; reviewed design, not root integrated |
| Bounded search/backlinks | `codex/iphone-bounded-search`; parent `8e836bc` is a copied-input snapshot and **must not be integrated**; actual feature delta `586e150` is pushed and not integrated; see the addendum |
| Drawing import safety | `codex/iphone-drawing-import-safety`, starts at `1346a03`; untested WIP `c2d5e19` is pushed; see the addendum |
| Recovery staging cleanup | `codex/iphone-export-cleanup`, starts at `79e928f`; clean at base; no cleanup code written; see the addendum |
| Profile selection/badge | Already integrated in `79e928f`; do not reapply the old private delta patch |
| Checkpoint guards/modal commands | Already integrated as `eba5728`/`1346a03` |

Local worktree paths, evidence logs and any uncommitted file lists belong in the private annex.
Before assigning more agents, check the final subagent reports and repository status for another
writer. The previous agents were asked to stop after preserving their current work.

## 8. Recommended next steps

1. Read the final stream addendum and inspect all branch deltas. Confirm no previous writer or
   simulator runner is still active. Keep root `codex/iphone-app` as the integration branch.
2. Check the outstanding CI runs on `79e928f` and retain their evidence. Resolve regressions before
   building on top; do not change unrelated timing budgets to make a gate green.
3. Integrate the bounded search delta and finish download freshness/cancellation serialization.
4. Integrate strict protection, compose startup/quiescence/retry, and test real app transitions.
5. Finish drawing import races, exact request-size preflight and protected library persistence.
6. Finish recovery staging and retirement cleanup ordering with fault/restart tests.
7. Complete keyboard Tab/Shift-Tab and the remaining editor/content parity review.
8. Run the combined native suite and required repository gates, then install that exact build into
   the dedicated QA simulator. Recheck the CUA-discovered table import and keyboard fixes first.
9. Finish the feature matrix below, fix issues, keep evidence and publish coherent checkpoints.
10. Only after all feasible acceptance passes, document physical-device/account constraints and
    make a release/integration recommendation. Do not revive this task's paused heartbeat without
    coordinating ownership with the new agent.

## 9. Remaining computer-use acceptance matrix

Use real native UI actions with synthetic data. API seeding and test assertions support a journey;
they do not replace checking the visible behavior. Do not report a screenshot alone as a pass.

- Connections: second profile, switching/re-pairing, token revocation, changed workspace, failed
  local index, offline launch, stale responses and recovery of the original workspace.
- Notes: daily/date/weekly edge cases, nested folders, multiple tabs/reopen, read-only/source mode,
  marked text, selection, hardware keyboard, Dynamic Type, VoiceOver and compact/landscape layouts.
- Content: corrected image insertion from a table cell; exact Undo; callout/source transitions;
  backlink navigation; internal/external/citation previews; activity/prose badges under live updates.
- Attachments: Files import including PDF, page preview, cancel/export, offline import → relaunch →
  reconnect, failed/uncertain upload, replacement, dependent note ordering and byte preservation.
- Downloads: note/folder/all selection, pins/new host files/changed versions, cancellation during a
  resumed read, retry/oversize, budget cleanup, dirty/recovery/live-editor protection and offline use.
- Drawings: all tools/properties/selection/arrangement, two-finger navigation, inline placement/
  resize/move/remove, images/replace/paste/library/SVG, limits and failure states, element links.
  Resolve the CUA drag discrepancy without substituting a unit-test claim.
- Agent: full Inbox filters, streamed reasoning/tools/results, reply/retry/discard, Stop/Retry,
  Show in Note, Repeat This, orchestrator turn focus and stale authority during an action.
- Approvals: all supported scopes, deny note, expiry/already decided, conflict/lost response and
  exact target display. Only mock actions; no real purchase or external send.
- Artifacts/live views: Markdown/code/image/document/isolated HTML, explicit save/share, offline
  missing states, visible-only subscriptions, frame zoom/history/staleness.
- Routines: templates/create/edit/schedule/notify/uses, file edit, pause/resume, Run Now, run history,
  budgets/errors, repeat task and notification routing.
- Settings/hosts: every shared agent/editor/periodic/connector setting and placement/readiness,
  machine/device controls, sync and host-only setup explanations, using isolated services only.
- Recovery: each note/drawing/structure/capture/upload conflict choice, verified Files export,
  cancellation, altered destination, concurrent new work, interrupted Forget and restart cleanup.
- Privacy/integration: protection migration/retry/failure, private alert text, scoped badge cleanup,
  background limitations, App Intent cold launch/offline capture and app-switcher privacy behavior.
- Performance: input/layout/scrolling on large synthetic notes/drawings, bounded search/download
  memory, launch/restoration and final required performance gates.

## 10. Toolchain, commands and operational pitfalls

Use Xcode 16.4's Swift 6.1.2 for app/native builds. The shell's default Swift is a different
installed toolchain. Select the compiler per command; do not change global developer settings.

```sh
export PATH=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin:$PATH

# Whole native app/unit/real-touch suite; destination UUID belongs to the local annex.
DDL_IOS_DESTINATION='platform=iOS Simulator,id=<test-device>' apps/mobile/scripts/test.sh

# Focused native test while iterating.
DDL_IOS_DESTINATION='platform=iOS Simulator,id=<test-device>' \
  apps/mobile/scripts/test.sh -only-testing:DailyDoListTests

# Unsigned device SDK build, not proof of physical-device execution.
DDL_IOS_DESTINATION='generic/platform=iOS' apps/mobile/scripts/build.sh

# Shared native package tests. A dedicated Xcode scratch path avoids mixed compiler caches.
apps/macos/scripts/test.sh DailyDoListEditor -- --scratch-path <xcode-test-build-directory>

TURBO_CONCURRENCY=1 pnpm check
```

The repo also requires the applicable build/size, benchmark, web E2E/performance, mock eval and
existing Vim gates described in `AGENTS.md`/`docs/CI.md`. Use changed/focused checks during
iteration, then complete final gates on the integrated tip. Required hooks must remain enabled.

Operational lessons:

- **Never run Simulator tests during CUA.** Even separate devices compete for the single
  Simulator app's foreground window. Reserve the entire simulator interaction window.
- Reacquire the Simulator app and inspect the window/device after a test runner finishes.
- Use the dedicated signed QA install; earlier unsigned simulator builds could not save Keychain
  credentials. Do not delete the QA app to resolve ordinary build problems; that destroys evidence.
- Additive Swift protocol changes once left stale incremental witnesses. A clean rebuild fixed
  that crash. Inspect build freshness before diagnosing it as a runtime data issue.
- Do not use ordinary multiline keystrokes to seed exact Markdown containing list/quote prefixes:
  native Return continuation intentionally changes the resulting lines. Simulator clipboard
  forwarding also failed once. Reseed the isolated host fixture explicitly, then verify the app
  refresh; do not count fixture setup as feature acceptance.
- The mock host's detected machine name can appear in UI. Do not commit screenshots showing it.
  Prefer a synthetic device name in future fixture setup.
- The root `.build/tests` had mixed-toolchain contamination; use the Xcode-specific scratch folder.
- Retain old failed-checkpoint/source originals. “Making the UI look clean” is not a valid reason
  to drop recovery or pending operations.

## 11. Physical-device and account constraints

No paid enrollment, TestFlight or APNs release is required for this scope. Do not purchase an Apple
subscription or weaken security restrictions. The app targets free-account development/signing.

A physical passcode-protected iPhone and account access are still needed to verify Personal Team
signing/reprovisioning, installation, Siri authentication, real protected-data behavior across boot/
lock/unlock, background scheduling/energy, device-only Keychain restore/reinstall behavior and any
camera/hardware interaction. Clearly separate these unavailable checks from simulator results.
Finish everything else; do not use the missing paid account as a reason to stop at a shell.

## 12. Transfer addendum

Final stream checkpoints and any late CI changes are appended here before publication. The private
local annex records exact machine-specific paths and running synthetic fixtures. Neither document
contains credentials, pairing codes, tokens or real note content.

### Final bounded-search report

`586e150ca6a2350e60bbe8b57546c69ab9ff715d` is pushed on
`codex/iphone-bounded-search`. The agent stopped; no tests/processes remain running.
**Cherry-pick only `586e150`, never its snapshot parent `8e836bc` or the whole branch.**

The delta changes nine files: MobileKit README; CheckpointStore; repository Listings/Search; new
TextScan and WorkspaceBoundedSearchTests; PhonePaletteModel; PhoneExplorerView; and
PhoneWorkspace+Backlinks. Metadata includes path/state/baseVersion/localRevision/acknowledgedRevision.
Bounded reads reject oversized checkpoints before allocation. Search/backlinks preserve dirty-first
priority and disclose partial coverage. Metadata can also support the pending download freshness fix.

Three focused regressions, including a 1,001-note index and oversized sparse checkpoint, passed;
all 123 MobileKit tests passed; generic iPhone device SDK build and full repository check passed.
No simulator/CUA validation was run for this stream. Two untracked root supporting files in its
worktree were copied only for compilation and deliberately excluded from the commit.

Tab/Shift-Tab work was **not started**. Protection and bounded search both touch CheckpointStore;
resolve any integration overlap preserving both access leases and bounded reads.

### Final drawing/protection report

Protection `22d1f60` and drawing WIP **`c2d5e19`** are both pushed; both worktrees are clean.
The agent stopped and has no tests/builds/Simulator work running. The drawing WIP is based on
`1346a03` and has **never been compiled or tested**. Formatting/hygiene/secret hooks passed only.
Read its `apps/macos/Packages/DailyDoListDrawing/IMPORT-SAFETY-WIP.md` before using it.

The WIP contains disposable-editor candidate validation, request-size measurement through the
actual WriteNoteRequest codec, an importContext closure, request-bound photo loading and initial
image/paste/library insertion routing. Protected library persistence remains entirely unwritten.
No root app lifecycle/protection composition or DrawingSession import-context wiring has been
added. Root's newer `focusElement` and pending-layout methods must survive integration.

Remaining tests include late/superseded photo loads, read-only changes during await, exact encoded
size boundaries including existing Markdown/baseVersion, unchanged scene/history on rejection,
one-step Undo on success, and protected legacy-library migration failures.

### Final export-cleanup report

`codex/iphone-export-cleanup` is clean at `79e928f`; **no implementation, tests or unsaved code
drafts exist**. Its agent stopped. The following is a proposed design, not shipped behavior:

- Foundation-only staging manager with a dedicated app-owned root, generated containers and
  opaque handles. Active exports retain exclusive leases; startup cleanup skips live leases across
  instances/processes, while process termination releases them.
- Remove owned staging after picker cancellation or successful external-copy verification. Keep
  the verified user copy and its proof intact. Cleanup validates ownership, rejects symlinks,
  never accepts arbitrary Files paths, and exposes failures for retry.
- Apply strict protection to staging through the privacy implementation. Run startup cleanup after
  protection preparation/unlock. Scope-specific retirement cleanup must not remove an active
  export's source. Wire both recovery/export views.
- Keep the retired profile until scoped alerts, staging and selected-profile cleanup finish.
  Profile removal is the final durable step. Change only the relevant helper; do not overwrite
  PhoneAppModel with an older branch copy.

Test successful verify→cleanup→conditional Forget, cancellation, restart, cross-instance active
leases, symlink/unknown-folder rejection, cleanup failure and crash boundaries before profile
removal. All these tests remain to be written.

### Ownership at publication

All three previous subagents have reported stopped. Root has stopped feature work and is only
publishing this handoff. Root's isolated mock host remains running for reuse; no root test runner
is intentionally left running. The app implementation is still `79e928f`; transfer documentation
commits do not integrate the three outstanding branches above.
