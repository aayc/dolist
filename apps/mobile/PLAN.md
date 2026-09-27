# Native iPhone app: implementation plan

Status: **implementation authorized and in progress**. The user approved full development on
2026-09-27, with a free Apple account and thorough automated and computer-use verification.
Current work and evidence: `IMPLEMENTATION.md`. Audited 2026-09-27 starting at `dfdf74f`
on `main`; independent Mac toolchain compatibility work reached `531d8d7` during the audit.
This replaces the earlier mobile outline. Recheck the baseline when implementation starts,
especially Obsidian migration work and agent-journal phase 2.

The goal is the complete Daily Do List experience on iPhone: native editing, drawings, the living
list, agent conversations and approvals, routines, remote-host management, safe offline work,
and Siri/Shortcuts. The phone is a client of an existing daemon. It does not run Node, an agent
harness, a sync-service lease, shell commands, or the Mac computer helper.

## 1. Scope and decisions

### Existing decisions retained

- Native Swift, SwiftUI for the application, UIKit for text editing and the drawing canvas.
  No web app shell. A restricted WebKit view is appropriate for an HTML artifact only.
- Reuse the Swift models, client, domain logic, Vim engine and drawing format. The daemon's
  REST/WebSocket protocol remains authoritative.
- Start with a free Apple account and installation from Xcode. Paid distribution and APNs are a
  separate release capability, not an assumption hidden in the core app.
- Siri and Shortcuts are in scope. iPad-specific layouts, widgets, a share extension and Live
  Activities remain later extensions, as previously decided. Hardware-keyboard commands and Vim
  **are** part of iPhone parity.
- Preserve plain markdown, agent attribution, soft deletion, local calendar dates, the mandatory
  server-side safety gate, and the existing four approval policies.

### Proposed implementation defaults

- **iOS 17 minimum**, matching the five reusable Swift products. Select a supported Xcode/Swift
  combination at the first milestone; deployment target and compiler version are separate.
- HTTPS through the existing private-network proxy, with Tailscale as the documented setup path.
  Support any correctly configured private HTTPS hostname accepted by the daemon. Home Wi-Fi
  does not mean connecting directly to a LAN IP or exposing port 7331: the daemon still binds
  loopback, requires configured DNS hosts and validates requests. No release ATS bypass.
- One active paired daemon serves notes and agent operations. Saved connections can be switched
  explicitly; each keeps an isolated credential and local data. No automatic host failover,
  separate notes/agent endpoints, or token reuse across hosts.
- Offline content is plain markdown in the application sandbox plus transactional metadata and
  an outbox. This is a working copy, not another participant in `SyncEngine`.
- Full delivery means all required milestones below, not merely an online Today screen.

### Definition of full features

Every shipped web/Mac workflow gets an iPhone interaction or an explicit host-only counterpart.
Mobile layout changes do not remove capabilities. Already-agreed product work—binary attachments
and Obsidian rendering parity—has a tracked dependency and an iPhone implementation; it is not
misrepresented as already built.

Full web drawing editing requires more than the current Mac canvas: its known gaps are included
in section 7. Features deliberately disabled in the web integration (Mermaid, AI drawing
creation, standalone scene load/save/export menus) are not new promises.

Finder, launch at login, menu bar, global hotkey, daemon supervision and granting macOS
permissions remain host-side. The phone supplies navigation, capture, notifications and host
status appropriate to iOS. Background execution is constrained by iOS; timely remote alerts
require the APNs option, and even APNs delivery is not guaranteed by Apple.

## 2. Codebase findings

| Area | Verified implementation | Consequence for iPhone |
| --- | --- | --- |
| Protocol | `packages/contract/src/wire`, core route constants, Swift contract fixtures | Change schemas, routes, clients, Swift models and generated docs together. |
| Swift reuse | Models, Client, Domain, Vim declare iOS 17; Drawing exposes an iOS-compatible model target | Five products already have an unsigned iOS build gate. This is compile coverage, not a phone app. |
| Mac editor | `DailyDoListEditor`: `NSTextView` on explicit **TextKit 1** | Reuse tokenizer/rules; replace AppKit layout, selection, events and views. The old plan's unconditional TextKit 2 choice needs a spike. |
| Notes | `NotesStore`, `Workspace`, `EditorCoordinator`: 300 ms debounce, one write per note, `baseVersion`, three-way merge | Preserve tested saving; add durable persistence and lifecycle recovery. Existing state is memory-only. |
| Drawings | iOS model; mostly portable Rough/CoreGraphics/CoreText renderer and editing state; AppKit canvas; `DrawingStore` | Extract portable targets and add touch UI. Save with scene merge, not markdown line merge. |
| Agent | `AgentState`, `AgentStore`, chat/routine/approval helpers, artifact policy, surface feed | Reuse logic after removing `NSImage` caches and Mac UI dependencies. |
| Remote access | App pairing, revocable tokens, private HTTPS proxy, REST and remote WebSocket header auth | Authentication already exists; QR presentation and native connection setup do not. |
| Daily/weekly | `/api/daily/:date`; `today` uses daemon timezone. Mac computes weekly path/template client-side | Send phone's explicit date; reuse Domain weekly rules rather than inventing a weekly endpoint. |
| Events | Push updates plus full refetch after reconnect; no replay cursor | Recreate streams after disconnect; refetch on foreground; retain snapshot/event race guards. |
| Mutations | Versioned note writes; chat body is only `text`; approval body is decision/scope/note | `x-ddl-client-id` attributes writes; it does not deduplicate a lost-response retry. |
| Placement | Fenced lease held by a daemon; optional relay to configured always-on host | “This device” refers to the connected daemon, never the phone. |
| Import | All host vault/import routes, including reads, reject paired devices with `forbidden_device` | Explain host-side setup; do not weaken restrictions or copy the Mac folder picker. |
| Attachments/rendering | B0/P in `docs/specs/obsidian-migration.md` not started | Binary storage/sync/file serving precede vault images/PDFs; tables/callouts/backlinks need shared work. |
| Notifications | Approval/routine WebSocket events and Mac notifications; no APNs | Add mobile routing/catch-up; APNs remains a separate transport. |

The runtime remains storage events → watcher → orchestrator → harness/subagent → safety gate →
execution provider/connectors. Phone edits enter that flow only when accepted by the daemon.
The app never simulates triage, executes tools, grants capabilities, or accepts offline approvals.
Pi, Cursor, MCP, browser and computer-use implementations stay on the host.

Important gaps beyond screen implementation:

- `health` exposes a vault name, not a stable workspace identity; WebSocket hello has versions
  only. The same URL can serve another vault after a host-side switch.
- `HTTPDaemonClient` defaults to `macos_…` / `macos/<version>`, buffers events without a bound,
  and ends every stream at `disconnect()`. Mobile needs explicit identity and lifecycle handling.
- `NotesStore` restores a remotely deleted whole file when it has local edits. Long-lived phone
  drafts need explicit recovery instead of automatically recreating a potentially moved task.
- Rename/delete lack the preconditions for unattended offline structural replay; folder operations
  can affect many files. Keep them online in this release.
- Mac drawings preserve image data but show placeholders, and defer several web editing tools.
- Mac checkboxes, badges and drawing handles are drawn without separate accessibility elements.
  Native iPhone accessibility requires additional work.
- Settings are vault-shared; host configuration is daemon-local. Routine schedules use daemon
  calendar context; travel with a phone must not silently change schedules.
- The task watcher also uses the daemon's local date for its watch window. A correctly named
  phone daily note can still be outside that window. Surface this state rather than promising
  every saved capture has started agent work.
- Agent-journal phase 2 already reserves durable client mutation IDs. Extend that design instead
  of making a competing mobile deduplication mechanism.

## 3. Feature and interaction checklist

Every row is required unless it explicitly says host-only or conditional.

| Feature | iPhone behavior | Reference / dependency |
| --- | --- | --- |
| Today | Open/create today, previous/next existing daily note, tomorrow, date picker; folder/name/template settings | Domain dates, daily route, `Workspace+Daily` |
| Weekly notes | Open/create using existing week-number and template rules | `DailyNotes`, `NoteTemplate` |
| Workspace | Open notes, recents, back/forward, close/reopen, per-note caret/scroll/undo; quick switcher and command search | `TabsStore`, `VaultTree`, `Fuzzy`, command catalog |
| Files/folders | Tree, create, rename, move, soft delete, path validation; preserve dirty content | `VaultStore`, workspace mutations, note routes |
| Search | Vault search, snippets/highlights, jump to source line; offline cached search with coverage label | Search API, `SearchModel`, local index |
| Editor modes | Live preview, source, read-only; font, readable width, spellcheck, line numbers, theme | Editor configuration/settings |
| Markdown | Headings, emphasis, strike, highlight, code, frontmatter, lists, quotes, rules, tags, links/wikilinks; list continuation, indent/outdent, formatting, undo/redo, find | Tokenizer, commands, shared editing vectors |
| Tasks | All existing checkbox statuses, touch toggle, keyboard commands, source round-trip | Task parser/status rules |
| Living list | Task badges, prose anchors, agent-colored lines/sparkles, unread dots, orchestrator chips/header activity; open thread/turn | Badge/chip builders, agent state, presence |
| Links/citations | Safe links; preview sheets from stored sources and cached notes; provenance preserved | `Thread.sources`, wikilinks, `LinkPolicy` |
| Vim | Motions/operators/counts, modes, registers/macros, search/substitute, vimrc, app ex commands; hardware keyboard and touch Escape/command controls | Vim engine/oracle, UIKit host |
| Drawing embeds | Display/insert/reposition/resize/placement/remove; source toggle | Drawing embed parser/edit rules |
| Drawing editing | Native canvas/tools/properties, touch selection/multiselect, arrows, undo/redo, pan/pinch; close web parity gaps | Shared engine and UIKit canvas; section 7 |
| Attachments | Authenticated image/PDF loading, cache/download, image sizing, safe preview, explicit Files/photo import | B0 binary API and embed layer |
| Tables/callouts/backlinks | Render tables with source-row editing; typed/foldable callouts; linked/unlinked backlinks and context | P shared work and mobile UI |
| Inbox | Needs-you first, pinned orchestrator, statuses/unread counts, existing note filters, routines separately grouped | `InboxGrouping`, `AgentState` |
| Task chat | Streamed markdown/citations, reasoning/status/tool rows, grouped successes/visible failures, reply/retry/discard, Stop/Retry, Show in Note, Repeat This | Chat helpers, thread APIs, mutation receipts |
| Orchestrator | Wake reasons, decisions/task links, follow-ups, Stop, focus requested turn | Orchestrator thread/focus logic |
| Approvals | Exact input/target, risk/reason, once/task/always, denial note, expiry/decision state, conflict handling | Approval schema/cards; broker authority |
| Artifacts | Text/markdown/code, images/documents, isolated HTML, explicit save/share | Artifact endpoint/policy |
| Live views | Browser/Computer tabs when provided, zoomable frames/action history, staleness, visible-only subscription | Surface feed; viewing, not remote-control input |
| Routines | Templates/create, schedule/instructions/notify/uses, file edit, pause/resume, Run Now, runs/budgets/errors, repeat task, notifications | Routine API/state; host scheduler |
| Agent settings | Enable/pause, harness/models/judge, concurrency, settle/watch/act-on-existing, timeout, all policies | Entire `AppSettings.agent` |
| Other settings | Editor/theme/vimrc, daily/weekly/templates, connectors/readiness, version/diagnostics | Settings schema and client |
| Host management | Named placement/readiness, machine pair/check/forget, sync, devices/code/revoke, remote hosts | Device/machine APIs with explicit host labels |
| Connection | QR/manual pair, reconnect/re-pair, saved endpoint switching, downloads/cache controls | Keychain and connection coordinator |
| Offline | Durable edits/creation/capture, cached drawings/threads/artifacts, chosen/full note download, local search and recovery | New repository/outbox |
| Notifications | Approval/routine alerts, badge, dedupe, deep links, stale decisions, privacy | Local/catch-up source; APNs conditional |
| Siri/Shortcuts | Add task, open Today, show/count approvals; truthful offline status | App Intents, atomic capture |
| Host-only setup | Obsidian import/update, vault switching, Finder, model/CLI credentials, daemon lifecycle, granting Mac permissions | Explain host action; retain authorization boundaries |

### Navigation and touch

- Four tabs: **Today**, **Notes**, **Inbox**, **Settings**, each preserving navigation state.
  Today/Notes share a document repository so the same note cannot have competing drafts.
- Date buttons/picker remain available; optional swipes must not conflict with text selection
  or back navigation. Notes uses a folder browser/search and an open-notes/quick-open sheet.
  Multiple open notes and Vim tab commands do not require a desktop tab strip.
- A badge opens a thread sheet, expandable to full screen, retaining editor state. Inbox opens
  the same thread. Returning must never reconstruct a dirty note from stale server text.
- Routines have a visible Inbox entry and their own list/run history. Settings separates Phone,
  Vault and Connected Host controls. Approval controls remain reachable above the keyboard.
- Software Return inserts a chat newline; Send sends. Hardware Return / Shift-Return follows
  existing chat shortcuts. This is an intentional mobile adaptation.
- Keyboard accessory: task, indent/outdent, formatting, links, undo/redo, drawing, dismiss.
  Every gesture has a button/menu/accessibility alternative.
- Narrow drawing floats display as full-width blocks when wrapping would leave unusable text;
  original markdown size/placement is preserved until explicitly edited.

## 4. Shared Swift architecture

Keep existing package paths initially. Moving all of `apps/macos/Packages` is unnecessary churn.
Add products/targets inside existing packages where possible; Mac must use the extracted logic.
Names below are proposed responsibilities, not modules that already exist.

```text
apps/mobile app: lifecycle, assets, signing, App Intents registration
  ├─ MobileUI: SwiftUI screens, UIKit editor/canvas adapters
  ├─ MobileKit: connection, navigation, durable repository/outbox, notifications
  │    ├─ WorkspaceCore: note/drawing saves, search, state, event routing
  │    └─ AgentCore: state/reducers, chat models, approvals/routine actions
  ├─ EditorCore: tokenizer, edits, line index/anchors, embeds, Vim requests
  ├─ DrawingCore: geometry, Rough, renderer, tools/history
  └─ existing Models + Client + Domain + Vim + DrawingModel

MobileKit ── HTTPS / WebSocket ── paired daemon ── vault + agent/relay
```

| Extraction | Move/reuse | Keep platform-specific |
| --- | --- | --- |
| EditorCore | `Tokenizer`, `Commands`, `Model`, `StyleSegments`, pure motion/embed rules, configuration/badge values, Vim requests/vimrc | Attributed styling, layout, input, selection/caret, accessibility, clipboard |
| AgentCore | `State`, portable `Store` actions/refresh, chat activity/items/scroll/pacing, markdown chunking, routine drafts/errors, link/artifact policy | Image decoding/cache, rich text views, display clocks, notifications, Dock/menu bar |
| WorkspaceCore | Save state machines, portable drawing persistence, tabs/history, vault/search/settings, badge/chip derivation, presence and event coordination | Boot/supervisor, windows/Finder/pickers, AppKit editor adapter |
| DrawingCore | `Editor`, `Geometry`, `Rough`, `Render` | Canvas, gestures, inline text view, controls, platform image wrapper |
| Shared support | Foundation scheduler/clock, shortcut values and link allowlist from `DailyDoListUI` | Display-link hosts, cursors, tooltip panels, styles |

Dependencies point from views to cores. Remove `DrawingTool` and `LinkTargets` dependencies on
Mac-only UI; share a small support target instead of duplicating schedulers. Keep portable
CoreGraphics/CoreText separate from the Foundation-only drawing model promise.

Extract incrementally with existing tests moved alongside logic. Do not copy Mac stores into
mobile and maintain two merge algorithms. Use protocols for storage, clocks, secure credentials,
notifications, network state and image decoding. Swift Observation drives coarse screen state;
text storage owns live editor content. Disk work, indexing, large merges and scene decoding run
away from input-critical work, and apply only to the document/revision that requested them.

## 5. Connection, authority and protocol changes

### Pairing and lifecycle

1. Host Settings issues a code with the existing route. Add QR rendering to web/Mac containing
   payload version, HTTPS origin, code and expiry, never a token. The existing response's `url`
   is only an origin, not a complete pairing link.
2. Scan in-app or enter URL/code manually. Validate the payload, show the destination, and redeem
   with `kind: app`. Universal links/Associated Domains are not needed for the free build.
3. Store the token device-only in Keychain. Use normal TLS validation and an ephemeral session;
   reject cross-origin redirects for pairing/authenticated requests. No shared cookies/cache.
4. Check health plus proposed workspace/capability identity before outbox replay; subscribe to
   events before connecting and bootstrap settings/tree/current note/agent.
5. Foreground always reconnects/refetches. Preserve event/snapshot race guards. Background saves
   locally, finishes only bounded network work, unsubscribes surfaces and disconnects. Stop
   timers/consumers; reconnect needs a new stream, not just the old `.resync` handler.
6. Unauthorized stops retrying and asks to re-pair. Distinguish unreachable, revoked, incompatible
   and relay read-only. Never erase drafts because a host is down or a credential is revoked.

Request camera permission only for scanning, retaining manual entry. Local-network permission
text must match actual connection needs; no unnecessary Bonjour discovery. Re-pairing verifies
workspace identity. Per-launch client attribution is `ios_…` / `ios/<version>`, separate from
persistent operation IDs and paired-device identity.

### Required additive contracts (not implemented today)

| Work | Proposed behavior | Purpose |
| --- | --- | --- |
| Workspace identity | Authenticated response/additive health fields: opaque `workspaceId`, serving-host identity, supported features; mutations carry expected workspace | Prevent drafts from reaching a different vault at the same URL |
| Atomic capture | `POST /api/daily/:date/append`: explicit date, capture time/timezone, text, durable operation ID; actual path/version/outcome returned | Capture/Siri without editor races or duplicated retries |
| Mutation receipts | Client-generated IDs for messages, decisions, routine create/run and retry/cancel where retried; return/query same operation | Extend journal phase 2 for relay/network uncertainty |
| Notification catch-up | Durable notification decisions with stable IDs and bounded cursor-based retrieval (or equivalent journal projection) | Recover missed `routine.notification`; do not guess `when_changed` |
| Calendar/watch context | Report effective host timezone/date and whether the captured daily note is watched | Explain travel/late-offline capture outside the agent watch window without silently changing its policy |
| Attachments/backlinks | B0 binary routes and P shared backlink-query contract | Phone cannot read host filesystem or use text writes for binaries |
| Optional APNs | Paired-device scoped push registration/rotation/removal and trusted sender | Suspended-app alerts; paid capability |

Legacy daemons can offer explicitly limited online use. The complete offline/capture release
requires these features. Do not detect support by attempting side effects or app version alone.

**Identity:** persist a stable opaque identity per logical vault. Synced replicas agree, while
an import into a new vault gets a new identity. Specify persisted schema, adoption/migration and
sync rules first; neither display name, absolute path nor daemon device ID identifies a vault.
Check expected identity server-side on mutations. A vault change must invalidate an active
session's writable context and force a handshake; checking only at launch is insufficient.
Automatic offline replay stays disabled until this contract exists.

**Atomic append:** create from configured template if missing, preserve existing content except
intended append/newline, append a user-owned task without agent markers, attribute it normally,
and let storage events wake the watcher. Bind ID to workspace/principal/payload hash; identical
retries return a receipt, changed payload with the same ID is rejected. Resolve concurrent
version conflicts with a bounded conditional-write loop.

A pending capture displayed in an open note is a projection of that operation, not a second
ordinary note edit. Drain its append before submitting a dependent full-note save, adopt the
returned base, and rebase any subsequent user edits. Test typing into a captured line before
and during its upload: the task must appear once without losing the later edits.

File writes and receipt persistence are not one transaction today. Persist operation preparation
and receipts; test crashes between them. If recovery proves the exact write completed, finish
the receipt. If not, report an indeterminate operation for reconciliation rather than appending
again. A lock, UUID or read-before-write does not itself guarantee exactly-once behavior. Capture
receipts stay with the serving endpoint; no automatic retry on a different host. Agent receipts
must survive relay/lease handover through the existing fenced journal design; uncertain tool
effects are never rerun automatically.

**Host controls:** use “Run on <host>” / “Run on the always-on machine.” Direct VM pairing does
not pair a Mac or release its lease. When another host owns the agent, show its name/read-only
reason. Saved connection selection is distinct from connected-host placement. Shared settings
and host-local settings can take effect differently across relay/sync; display acknowledged
status rather than assuming instantaneous remote change.

Wire changes update contract schemas/route tables, core constants, daemon/relay, web client when
affected, Swift models/client, fixtures and generated protocol together. Persisted additions get
version/migration rules in `docs/DATA_FORMATS.md`.

## 6. Offline persistence and reconciliation

### Repository

Use a connection-profile + verified-workspace namespace containing plain markdown working files,
immutable merge bases, and a small transactional SQLite index/outbox (system SQLite, behind an
interface). Record paths, base versions, local/durable/acknowledged revisions, hashes, operation
IDs, captures, drawing state, downloaded assets and notification cursor/deduplication.

Cache metadata/settings/templates, recent/pinned notes, open drawings, recent threads and chosen
artifacts. Offer chosen-folder or all-note offline downloads. Bound disposable caches by bytes;
never evict dirty content, its merge base or pending assets. Offline search states its coverage.

Distinguish saving locally, saved on iPhone/waiting to sync, syncing, synced, failed and needs
review. “Saved offline” requires durable acknowledgement. Queue edit deltas away from the input
callback and checkpoint markdown asynchronously. Atomic files plus transaction/generation
references must recover the last durable revision after interrupted checkpoint/metadata writes.
Handle disk full, locked protected data and migration/corruption errors without empty-file
replacement. Preserve exportable recovery copies before repair.

This journal is phone client state, not another agent journal. It contains no harness credentials
or policy grants. Keep drafts through termination, upgrades and re-pairing. Explicit Forget offers
sync/export/discard of pending work before deleting token/cache/outbox. Export is a user action.

### Offline operation policy

| Operation | Offline behavior | Reconnect behavior |
| --- | --- | --- |
| Cached note/checkbox edit | Durable local edit | Conditional save with retained base; three-way merge |
| New ordinary note | Local draft, reserved path, create-only intent | `baseVersion: null`; collision never overwrites |
| Daily capture | Durable operation fixed to phone's captured date | Same atomic-append ID; reconcile response with open editor |
| Full daily/weekly creation | Cached settings/template, or explicit draft if unavailable | Recheck path/settings/remote existence; no silent date/path change |
| Drawing edit/create | Original file + local scene/tombstones and dependent embed | Scene merge; create/upload drawing before dependent embed acknowledgement |
| Search/threads/artifacts | Cached data with coverage/last-updated state | Refetch; unavailable content never shown as empty editable data |
| Chat | Durable composer/unsent draft, no delayed automatic send | User sends; receipt-based retry only resolves a send already attempted |
| Approval/Run Now/Retry/Stop | Read-only; no queued future action | Refresh authority/status, then new explicit user action |
| Existing file/folder rename/move/delete | Online-only; local drafts can rename/discard | Drain affected saves, perform, remap cache/history; refetch uncertainty |
| Shared settings/placement/sync | Cached read-only; phone-local preferences work | Require online acknowledgement; never replay stale policy changes |
| Routine instructions | Cached markdown edit | Merge/save file; semantic Run Now/Pause/Resume controls stay online |

Offline structural changes need future conditional/idempotent APIs and rename identities. This
connectivity constraint does not remove their full online implementation.

### Reconciliation rules

1. Verify credential/API/host/workspace. Cancel old-connection tasks; hydrate drafts before
   displaying server content. Never replay into a different workspace or silently chosen host.
2. Fetch current settings/tree/versions while reducing new events. Stale snapshots cannot replace
   newer events or local revisions. The transmitted revision is immutable; later edits queue next.
3. Serialize writes per document and order creation/capture/asset dependencies. Clean documents
   adopt remote state and never write it back. Dirty text uses `TextMerge(base, local, remote)`.
4. Apply only remote hunks to the live editor, preserving selection, marked text and undo. Merge
   disjoint edits automatically. Same-line conflicts retain local edits and preserve the remote
   version in a deduplicated conflict copy before acknowledging the merge, with a review link.
5. A dirty whole file that disappeared or may have moved becomes a recovery draft. Do not guess
   renames from equal content or recreate the old task note. Clean deleted cache entries disappear.
6. Drawings use `SceneMerge`, version/nonce/tombstones and preserved file sections, never line
   merge of JSON. Unreadable remote drawing content preserves the local scene in recovery; it
   cannot become a successful acknowledgement or be overwritten.
7. Persist server acknowledgement/outbox state atomically. A lost response is reconciled against
   version/content or a receipt. Acknowledging an earlier revision never clears later edits.

No replay changes agent attribution, checks additional tasks or accepts an approval. Phone date,
daemon date, routine schedule zone and capture timestamp are distinct. Test midnight, DST,
week/year boundaries and travel. Capture uses the original date even when replay happens later.
If that note is outside the daemon's watch window, show that it was saved but is not being
watched; offer an explicit route to the orchestrator/settings. Do not expand the watch window or
automatically dispatch old tasks. Show routine schedules in the host's effective zone, with a
phone-local equivalent when different.

## 7. Native editor and drawings

### Editor strategy

Run a bounded text-engine spike first. The Mac relies on TextKit 1 null/control glyphs, exclusion
paths and precise UTF-16 offsets. TextKit 2 is not a drop-in replacement for these techniques.

**Recommended starting point:** explicit TextKit 1 `UITextView`, maximizing reuse of proven
live-preview behavior. Compare TextKit 2 using identical acceptance cases; select it only if
source positions, IME, undo, embeds and budgets hold without a much larger custom input system.
Keep the choice behind the adapter. This supersedes the earlier outline's TextKit 2 assumption.

The spike must prove:

- Syntax reveal without rewriting markdown; narrow/wrapped checkbox/badge regions; agent marker
  caret/Enter behavior; correct touch selection and read-only behavior.
- Marked-text composition, Chinese/Japanese input, dictation, autocorrect, emoji/combining text,
  RTL, paste, selection handles, keyboard dismissal, rotation and Dynamic Type.
- Incremental UTF-16 edits, local/remote revision separation, per-note undo across remote changes
  and note switching, without stale full-document replacements.
- Drawing float/block layout, entering/exiting native canvas without leaking input into the note,
  stable scroll through keyboard/layout changes, and native accessibility.
- Large-document performance with no network, filesystem work, full parse or SwiftUI document
  replacement in the keystroke callback.

Move tokenizer/commands, not the AppKit-dependent `MarkdownHighlighter` unchanged. Separate the
incremental parse cache from UIKit styling. Changed-line work is immediate; fence/frontmatter
propagation and large reflows must be bounded/deferred with revision checks.

Mirror J1–J8 and orchestrator rules: remove anchors when their text disappears, badges take
precedence over chips, outcome timing matches, citations use stored sources, editor presence is
throttled (400 ms in the current reference). Suspension stops presence; background replay must
not pretend the user is currently typing.

For Vim, implement `VimEditor` over UIKit text/selection/layout/history. Share the engine, one app
Vim instance, per-document sessions, registers/macros and vimrc. Add key-command/press and
clipboard adapters; IME takes precedence. Keep touch insert mode usable, offer Escape/command
entry, and route ex commands through the mobile command registry. Mac window/Finder commands
report unavailable. Replay all existing vectors through the real mobile host with preview on/off;
any exclusion needs a documented platform reason, not an arbitrary reduced sample.

### Drawing strategy

Extract the native renderer/editor rather than embed JavaScript. A UIKit canvas maps touch into
scene-coordinate pointer events, retains static-layer caching, and overlays touch-sized handles
and inline text. Pan/pinch must not create strokes. Multiselect, duplicate, constraints and
properties need explicit controls because fingers have no Shift/Option key. Compact embeds open
a full-screen canvas and return to the same note position; every embed receives updated previews.

Complete the web editing gaps in the shared native engine:

- Decode/render preserved embedded images; explicit picker insertion/replacement retaining the
  scene `files` map. External vault attachments depend on B0's binary API.
- Rotation, layer ordering, group/ungroup, locking, clipboard preserving references, and
  multi-element alignment/distribution where exposed by the web editor.
- Frame creation/editing, detailed line/arrow point editing, grid/snapping and elbow-arrow edits.
- Inventory the pinned web toolbar/context/property controls into a finite parity checklist at
  milestone 0, including library/shape-reuse controls if exposed. Ten Mac tools alone do not
  establish full web parity. Preserve unsupported future elements without destructive conversion.

Pure changes belong in the shared engine so Mac benefits. Preserve plugin IDs, edit/undo version
and nonce updates, deletion tombstones, unknown JSON/file sections, Excalifont licensing and
Rough determinism. Adapt font resource lookup for iOS bundles. Use shared TypeScript/Swift
format and scene-merge vectors rather than independent contradictory examples.

## 8. Agent UI, safety, artifacts and settings

Retain agent touch counters/load buffers that protect newer events from late snapshots. Split
raw surface data from platform image caches; decode the latest frame off the main thread and
coalesce drawing by frame. Bound memory without dropping authoritative messages/approvals. On
event overflow, refetch/reconnect instead of silently losing state.

Chats retain stable rows/viewport, progressive markdown, tool grouping/failures, reasoning times,
optimistic sends and Jump to Latest. Reply drafts persist locally. A 202 means accepted/pending,
not completed. Only visibly active threads are marked read; background/notification loads are not.

Approval cards show exact action/target/input, risk/reason, machine, expiry and scope. Default to
once; task/always remain explicit choices. Show submitting until acknowledged; expired or already
decided cards adopt server state. No offline decision queue, bulk approval shortcut or Siri
approval. Notification actions require unlocking and fresh authority; open the card for review
when an alert cannot show its complete target. A stale card cannot widen a grant.

Artifacts stay authenticated. Native text/markdown/image/document preview uses bounded decoding;
HTML uses a dedicated WKWebView with scripts, network, navigation and persistent website data
disabled. It gets no daemon token, JavaScript bridge or arbitrary file access. Reuse the link
allowlist. Saving/sharing is explicit; unknown active content downloads instead of executing.

Expose all shared editor/theme/daily/weekly/agent settings and label their vault-wide effect.
Phone-only settings cover notification privacy, download/cache limits, touch preferences and
navigation restoration. Any local presentation override must say so. Host screens name the
machine affected by placement, sync, connector readiness and device revocation. API keys, CLI
logins and connector configuration remain on the host. Preserve Run Everything confirmation.

## 9. Notifications, Siri and Apple constraints

### Free-account release

Personal Team provisioning profiles expire after seven days and need rebuild/reinstall. Keep a
stable bundle identity; deleting an app can lose unsent drafts. APNs and TestFlight require the
paid release path. [Apple account overview](https://developer.apple.com/help/account/basics/about-your-developer-account),
[membership capabilities](https://developer.apple.com/programs/whats-included/).

Use UserNotifications for events actually received, with stable IDs, categories/grouping,
deduplication and deep links through one router. Hide sensitive note/action text on the lock
screen by default, with an opt-in preview preference. Respect routine notify policy, visible
thread/routine suppression and needs-user semantics. Clear obsolete alerts after decisions;
baseline first pairing rather than notifying all historical runs. Request permission with context.

Background refresh offers occasional small catch-up work, not a timer or persistent socket. The
system decides when it runs. Save locally before suspension and honor expiration/cancellation;
no unrelated audio/location modes to stay alive. Do not promise timely approvals while the app
is stopped without APNs. [Apple background strategies](https://developer.apple.com/documentation/BackgroundTasks/choosing-background-strategies-for-your-app),
[UserNotifications](https://developer.apple.com/documentation/usernotifications/).

Proposed protection default: device-only, non-synchronizing Keychain accessible after first unlock
for background refresh, with protected local files matching those access needs. Approval and
Siri disclosure still require unlock. Offer stricter unlocked-only protection with background
refresh unavailable. Conceal app-switcher snapshots. Never log tokens, codes, note/notification
bodies or authenticated URLs. Test first boot before unlock and restore/reinstall behavior.
[Apple Keychain accessibility](https://developer.apple.com/documentation/security/item-attribute-keys-and-values).

### Siri and Shortcuts

Keep App Intents in the app target using the same capture/repository service. Do not assume an
App Group or separately provisioned extension is available with Personal Team signing.

- **Add to Do List:** accept text, preserve phone date/timezone and one operation ID, durably
  enqueue atomic append, then report added or saved on iPhone/waiting for connection. A timeout
  never creates a second operation; no claim the agent started before daemon acceptance.
- **Open Today's Note:** use the ordinary router, including offline cold launch.
- **Show/count Pending Approvals:** authenticate, refresh or label cached counts, open Inbox for
  decisions; do not speak sensitive bodies while locked.
- Provide App Shortcuts and test Siri's real text-parameter collection. Do not promise arbitrary
  natural-language phrasing works identically on every device/OS.
- Set intent authentication explicitly: the framework default permits execution while locked.
  Adding a task can trigger agent actions under the selected policy, so it needs deliberate
  authentication, not treatment as a harmless unauthenticated write.

App Intents supports these integrations; exact free-team signing and invocation must be proven
in milestone 0 rather than inferred from the similarly named SiriKit capability.
[Apple App Intents](https://developer.apple.com/documentation/appintents),
[intent authentication](https://developer.apple.com/documentation/appintents/appintent/authenticationpolicy).

### Optional paid-account release

Add the APNs provider to a trusted daemon/notification service, never the phone: token
registration/rotation/revocation, environment/topic isolation, sender credentials, error handling
and durable notification ownership through lease handover. Credentials stay outside repo and
synced settings. Push minimal opaque routing IDs; fetch details over the private authenticated
connection. APNs is outbound from the host and needs no public daemon endpoint.

One notification router deduplicates local/catch-up/push events. Loss of the private connection
still prevents approval; opening an alert explains that state. Signed archives/TestFlight come
after account enrollment. If timely suspended-app alerts are a first-release requirement, this
milestone becomes a prerequisite, not something replaceable by frequent background refresh.

## 10. Tooling, tests and performance

### Build and distribution

- Thin app target and local Swift packages; no bundled daemon or personal vault. Keep mobile out
  of pnpm workspace packages unless a Node tooling task actually needs it.
- Retain the earlier generated-project proposal: pinned XcodeGen with a committed declarative
  spec, local signing/team settings in gitignored xcconfig. Pin the compatible generator/toolchain
  during milestone 0; no personal signing assets, device names or profiles in the repo.
- Add mobile generate/build/test/run-simulator scripts and device-install instructions. Select
  Xcode through per-command `DEVELOPER_DIR`, without changing system `xcode-select`.
- Audit found Xcode 16.4 and iOS 18.5 SDKs installed. This verifies presence, not mobile readiness:
  independent setup work addressed older-SDK/compiler compatibility in `531d8d7`; formatter
  compatibility and a passing supported toolchain still need checking at mobile kickoff.
- Shared pure tests run on macOS through the repository wrapper; UIKit tests run in Simulator.
  XCUITest is for real input, lifecycle and system interactions, not duplicated domain logic.
- Demo/UI tests connect to a **real daemon launched by the Mac test runner**, with mock agent,
  synthetic temporary vault/home and free port. iPhone never starts Node. Test-only loopback
  transport exceptions stay out of release; physical tests use a private reachable test host.
- Update changed-package selection, fixture lookup/bundling, cache inputs, format coverage and
  iOS build gates for new targets. Simulator fixtures cannot depend on host source-tree paths.

### Validation matrix

| Layer | Evidence required |
| --- | --- |
| Existing shared tests | Contract fixtures, Domain/merge properties, Vim vectors, drawing format/Rough/scene merge continue passing after extraction |
| Repository model tests | Crash at every durable boundary, late ack/edit during save, revocation, changed workspace, deleted/moved file, conflict retry, disk full, migration, dirty-asset eviction protection |
| Real daemon integration | Pair/revoke/header auth, private TLS proxy, capture race/lost response/restart, idempotent relay mutation, two clients deciding one approval, lease handover/read-only fallback |
| UIKit editor/canvas | Actual input/marked text, selection/undo, syntax reveal, badges/tasks, complete Vim host replay, touch gestures, no note input while drawing |
| UI journeys | Pair→type→agent result; prose/citation; approve/deny; chat/Stop; routine create/run; offline→termination→merge; web→phone→web drawing; attachment; Siri capture |
| Accessibility | VoiceOver actions for drawn controls and drawing elements, accessibility Dynamic Type, Reduce Motion, contrast, landscape, keyboard/switch access, alternatives to drag-only actions |
| Physical device | Free-team signing/reprovision, Siri discovery/parameters, dictation/IME, notification actions, lock-state protection, private-network transitions, device performance |

Add iPhone journeys to `docs/USER_JOURNEYS.md` and reuse existing assertions for shared behavior.
Do not replicate the entire backend scenario/eval suite. Wire changes run contract/client/daemon
checks; safety-affecting changes run mock evals; parsing/merge changes get deep property sweeps.
Every implementation milestone runs repository-required checks plus affected Swift/UI tests.
An unsigned build alone is not acceptance.

### Proposed phone budgets

These are targets, not measurements. Calibrate release budgets on the oldest supported test
phone, with separate simulator CI multipliers, in milestone 0:

- Cached Today usable within 500 ms of scene activation after startup; network never blocks
  showing durable drafts. Measure cold process launch separately.
- 2,000-line mixed note/30 badges: ordinary input/style p95 below 8 ms at 60 Hz. Also measure
  10,000-line Vim and a six-drawing note. No network/disk/full parse on input callbacks.
- 10,000-note tree and 400-thread/60-approval Inbox use virtualized/bounded rendering. Warm
  note switches target under 100 ms; cached search under 100 ms after dispatch.
- No whole-chat rerender per token. 2,000-element drawing pan/drag/freehand within 16.7 ms/frame;
  establish explicit decoded-image/cache memory ceilings from physical-device profiling.
- No animation/ping/reconnect loops during suspension; idle screens have no display-link work.
  Energy measurements include streaming chat and live surface viewing.

Record baselines in `docs/PERFORMANCE.md`; profile before widening budgets. Mac tab-switch
restyling, chat row rebuilds, unbounded event streams and large tree payloads are risks to measure,
not implementations to copy blindly.

## 11. Implementation sequence and exit gates

| Milestone | Work / ownership boundary | Depends on | Done when |
| --- | --- | --- | --- |
| 0. Prove foundations | Freeze feature checklist; toolchain/generated shell; free-team/App Intent proof; TextKit spike; baseline fixtures; identity/receipt contract designs | Implementation authorized | Simulator/device shell works; editor decision recorded; entitlements verified; no production data touched |
| 1. Extract shared logic | EditorCore, AgentCore, WorkspaceCore, DrawingCore, support; Mac imports/tests and platform adapters | 0 | Existing Mac behavior/vectors preserved; all reusable products build for iOS |
| 2. Connect and persist | Keychain/manual+QR pairing, identity/capabilities, lifecycle, repository/outbox/migrations/recovery | 0 and portable 1 | Pair/revoke/relaunch offline; durable draft recovered; changed vault at same URL cannot receive it |
| 3. Notes/editor | Daily/weekly/navigation/tree/search/commands; modes/tasks/badges/chips/citations; offline merge | 1–2 | J1–J8 on phone; input/IME and performance pass; clean stale text never writes back |
| 4. Agent workspace | Inbox/chat/orchestrator/approvals/routines/settings; artifacts/surfaces; host management; journal mutation receipts | 1–2; 3 for anchors | Follow/redirect/approve/stop over real daemon/relay; no duplicate work from retries/handover |
| 5. Drawings/content parity | UIKit canvas/embeds, native web-parity gaps, B0 attachments, P images/tables/callouts/backlinks | 1–3 and shared B0/P | Cross-client round-trip, offline scene merge, complete content display; malformed/unavailable files never overwritten |
| 6. Vim/phone integration | UIKit Vim/vector replay; accessory controls; capture/Siri; notification catch-up/local alerts | 1–4 and capture/receipt API | Full vector coverage, hardware/touch input, real Siri capture once across failures, correct alert privacy/state |
| 7. Release hardening | Crash/lifecycle matrix, accessibility, memory/energy/performance, signing/install guide, recovery/diagnostics/docs | 2–6 | Full checklist on Simulator and phone; required CI green; no unresolved data-loss/safety failure |
| 8. Push/distribution option | Paid entitlement, APNs registration/sender/handover, archives/TestFlight | 4, 6–7; paid account | Suspended-phone alerts, stale/offline decisions safe, token lifecycle verified |

Two explicit release gates: **free-account feature-complete iPhone app** after 7, with the stated
background-alert constraint; **push-enabled distribution** after 8. Neither treats missing
editor/drawing/routine/offline capability as later polish.

Critical path: toolchain/editor proof → shared extraction → durable connection/document layer →
editor/content → physical-device quality. Agent UI and backend capture/receipts can proceed after
their interfaces stabilize. B0/P and full native drawing parity are substantial dependencies.
If implementation is later split among contributors, use written scopes in `docs/specs`, isolated
branches and one integrator for contracts/manifests/`PROGRESS.md`. This plan launches no streams.

Planning estimate: **12–20 experienced engineer-weeks** for milestones 0–4 and 6–7, plus **6–12**
for complete native drawing parity and B0/P if not delivered separately, plus **2–4** for APNs.
These are uncertainty ranges, not a calendar commitment or agent-runtime prediction. Re-estimate
after milestone 0; input correctness and crash recovery dominate more than screen count.

## 12. Choices to confirm at implementation kickoff

Implementation was authorized on 2026-09-27. Use the defaults below without repeatedly asking;
record evidence-driven adjustments in `IMPLEMENTATION.md`. The user confirmed the free-account baseline.

- Validate proposed iOS 17 deployment against the intended phone and a compiler that builds the
  repo. Keep the existing floor unless evidence requires raising it.
- Keep free-account delivery first, or make paid APNs a prerequisite for the first personal
  release. Timely background approval alerts require the latter.
- Choose the first private HTTPS endpoint: Mac or always-on host. Tailscale is the proposed
  connection path; this plan does not provision infrastructure.
- Confirm recent/pinned offline default with optional full downloads, and protection mode:
  accessible after first unlock for refresh, or stricter unlocked-only.
- Rebase the feature checklist onto whatever B0/P/journal work has shipped by kickoff, using it
  as shared infrastructure rather than implementing it again.

## 13. Source map

Paths are relative to the repository root. These are principal inspected sources, not a claim
that every line or runtime behavior was executed during planning.

- Product/architecture: `AGENTS.md`, `PROGRESS.md`, `docs/ARCHITECTURE.md`,
  `docs/CROSS_PLATFORM.md`, `docs/ALWAYS_ON.md`, `docs/USER_JOURNEYS.md`,
  `docs/PERFORMANCE.md`, `docs/specs/{agent-journal,obsidian-migration}.md`.
- Scope: web/Mac READMEs, Mac `Commands/CommandCatalog.swift`,
  `Workspace/Workspace+Daily.swift`, `Stores/TabsStore.swift`; web
  `features/drawings/DrawingEditor.tsx` and `excalidraw-assets.ts`.
- Persistence/events: Mac `Stores/{NotesStore,DrawingStore,SettingsStore}.swift`,
  `Model/AppModel+Events.swift`, `Workspace/{EditorCoordinator,PresenceReporter}.swift`.
- Editor: `apps/macos/Packages/DailyDoListEditor/README.md` and
  `Sources/DailyDoListEditor/{Tokenizer,Commands,Model,Styling,Drawings,Vim}`;
  `packages/editor/README.md` and Vim vectors.
- Drawing: `apps/macos/Packages/DailyDoListDrawing/{Package.swift,README.md}` and its model,
  renderer/editor sources; `packages/core/test/drawings` fixtures.
- Agent: `apps/macos/Packages/DailyDoListAgent/Sources/DailyDoListAgent/{State,Store,Chat,Support,Views}`,
  especially refresh/commands, approvals, thread view, artifact policy/view, surface state.
- Client: `apps/macos/Packages/DailyDoListClient/README.md`, `DaemonClient.swift`,
  `HTTPDaemonClient.swift`, `EventConnection.swift`, `EventBroadcaster.swift`, `RESTTransport.swift`.
- Backend: `packages/contract/src/wire`, `packages/storage/src/types.ts`, daemon
  `routes/{daily,notes,vault,pairing,device,machine,settings,import,artifacts,computer}.ts`,
  `relay/routes.ts`, and `packages/agent/src/tools/contracts.ts`.
- Build: `.github/workflows/macos.yml`, root scripts, Mac test wrapper/integration harness.

Apple sources are linked where relevant. UIKit supports explicit selection of its text layout
manager; the final editor choice is still a spike, not a claim the Mac adapter runs on iPhone.
[Apple UITextView initialization](https://developer.apple.com/documentation/uikit/uitextview/init(usingtextlayoutmanager:)).
