# Native iPhone implementation handoff

## Durable user instruction (2026-09-27)

The user explicitly authorized full and complete native iPhone development, superseding the
previous planning-only request. They do not have a paid Apple developer account. They will be
away for several days and asked us to keep working until everything is implemented and tested,
including thorough computer-use checks of all features. On the same day they explicitly authorized
many subagents to accelerate implementation. Preserve these instructions through
compaction. The user subsequently said "don't do vim mode in iphone at all": mobile Vim,
vimrc/settings and mobile Vim acceptance are excluded. Keep existing Mac/web Vim intact.
Do not stop at a prototype or declare unverified features complete.

Read this file, `PLAN.md` and root `PROGRESS.md` on every continuation. Keep working on
`codex/iphone-app` in its isolated worktree. Commit and push coherent checkpoints, maintain this
ledger, and integrate only after required checks pass. A persistent task goal and hourly
continuation are configured. Do not create duplicate work if a turn is already running.

## Scope and boundaries

- Deliver all required rows of PLAN section 3 and milestones 0–7. Paid APNs/TestFlight remain
  outside the free-account release. Do not purchase enrollment or weaken platform restrictions.
- Native SwiftUI/UIKit, iOS 17 minimum initially; use existing Swift packages and daemon protocol.
- No app implementation may silently bypass the daemon safety gate or remote-host restrictions.
- Do not operate the real vault, installed Mac app or its daemon. Never bind/kill ports 7331/5173.
  Tests use synthetic throwaway vaults and independent daemons on free ports.
- Keep credentials out of public source, logs, screenshots and committed test fixtures.
- A simulator pass does not prove physical-device signing, Siri or energy behavior. Track these
  separately and keep completing all work that does not require an absent device/account.

## Baseline and working decisions

- Started from the Mac compatibility integration and planning documentation on main.
- Xcode 16.4 includes Swift 6.1.2 and iOS 18.5 SDK/runtime. Use per-command Xcode selection.
  A separately installed Swift toolchain is selected in shell PATH; do not assume `swift` and
  `xcrun swift` identify the same compiler. Simulator access requires execution outside sandbox.
- App project: pinned XcodeGen, local packages, no paid entitlements. Team/bundle overrides stay
  in ignored local signing configuration.
- Editor: start with explicit TextKit 1 so source-preserving glyph/live-preview rules can be
  shared with Mac. Prove input/undo/composition/performance before declaring the spike complete.

## Milestone ledger

No feature is complete merely because its API or a placeholder screen exists.

| Milestone | Status | Remaining acceptance |
| --- | --- | --- |
| 0 Foundations | In progress | App builds for simulator/device SDK; editor input/undo/composition proven; broader input/embedding/device acceptance remains |
| 1 Shared logic | In progress | EditorCore extracted and Mac editor tests pass; AgentCore and DrawingCore extracted; WorkspaceCore navigation extracted; full workspace integration remains |
| 2 Connection and durability | In progress | Workspace identity/capture/receipt protocols and durable caches integrated; real Keychain/manual pairing and offline relaunch/merge verified; broader recovery matrix remains |
| 3 Notes/editor | In progress | Today/ordinary notes/creation/editing and captures work; hierarchical explorer, search, history/date navigation and recovery UI integrated; full living-list/content matrix remains |
| 4 Agent workspace | In progress | Shared AgentCore and native screens integrated; Inbox/result/artifact checked; receipt-aware actions and settings/hosts integrated; full caches and action CUA remain |
| 5 Drawings/content | In progress | Shared native canvas, images and arrangement implemented; app persistence/embeds and remaining parity/B0/P remain |
| 6 Phone integration | In progress | Native keyboard/accessory, capture/Siri, local notification catch-up; Vim explicitly excluded |
| 7 Hardening | Not started | All automated gates, computer-use feature matrix, recovery/accessibility/performance |
| 8 Paid push/distribution | Not applicable | User has no paid account; keep optional design separate |

## Active ownership and next actions

The written stream scope is `docs/specs/iphone-implementation-streams.md`. The integrator owns
`codex/iphone-app` and app composition. Parallel streams completed the shared drawing canvas,
settings/hosts, receipt-aware actions, notification catch-up, structural recovery, binary
attachments and bounded thread/artifact cache foundations. Current work: remaining drawing parity;
AgentCore/MobileAgent offline cache integration; native App Intents/local notifications and routing.
Integrate reviewed commits and rerun affected tests. No mobile Vim work is authorized.

1. Finish app composition with durable composers, receipt-aware agent actions, full settings and host controls.
2. Integrate structural/recovery UI, cached content, drawings and complete notes navigation/search.
3. Complete editor living-list/content parity, Siri/capture and notification integration.
4. Continue the release matrix; no feature is complete based on API availability alone.

## Validation evidence

- Xcode 16.4 / iOS 18.5: unsigned simulator and physical-device SDK builds pass.
- iPhone simulator suite passes: native real-keyboard UI input, invalid-origin UI, origin
  validation, task continuation, formatting undo, caret preservation, remote edits, marked-text
  composition with remote arrival, and edited-line emoji pixel regression.
- Shared extraction: Mac Domain, Client, UI, Agent, Drawing and all 300 Editor tests pass,
  including existing Vim vectors and editor performance checks. All 29 real-daemon integration
  tests pass after narrow Swift 6.1 isolation fixes. The app suite passes 305 of 306 tests;
  window-opening performance remains about 6.4 seconds against a 1-second budget even alone.
  An isolated pre-extraction baseline reproduces 6.44 seconds versus 6.41 seconds here. This
  is a pre-existing local failure, not a measured extraction regression. Do not widen the budget.
- `pnpm check` and changed-file lint pass for the foundation checkpoint.
- Foundation CI and macOS workflows both passed on `a972928`, including all web functional/performance
  tests, benchmarks, Vim, evals, Mac packages/integration and shared iOS builds.
- Native signed simulator suite passes including real Keychain persistence and UIKit live-edit
  conflict/IME regressions. Connection/profile tests, offline repository and capture tests pass.
- Backend receipt tests prove paired relay lost-response retry, fenced preparation and lease
  handover without redispatch. Shared drawing checkpoint passes 102 package tests.
- This remains an incomplete app. Full feature and physical-device matrices remain open.

## Computer-use evidence

| Build / device | Synthetic scenario | Observed result / follow-up |
| --- | --- | --- |
| Foundation working tree / iPhone 16 Plus, iOS 18.5 | Toggle checkbox, switch source/preview, type task and press Return | Markdown preserved; checkbox changed; next task prefix inserted |
| Same | Tap into prose and type | First check found a recognizer consuming editor taps; restricted recognizer to checkbox hits, then real typing passed |
| Same, corrected build | Type on a line containing emoji | First check found disappearing emoji glyph; deferred style transaction plus pixel regression fixed it; repeated actual input shows leaf preserved |

| Integrated app / iPhone 16 Plus, iOS 18.5 | Manual pair through isolated HTTPS proxy, then open Today | Real TLS succeeded; initial unsigned build exposed missing Keychain identity. Simulator-only signing corrected it, real Keychain regression added, pairing then passed |
| Same | Type task, open Inbox, open completed mock-agent thread and its Markdown artifact | Note reached real daemon, task completed in mock mode, unread/result/artifact displayed in portrait and landscape |
| Same | Capture text, stop test host, edit downloaded note, terminate/relaunch app offline | Capture appeared exactly once; offline edit showed Saved on iPhone and survived process loss |
| Same | Edit another line remotely, resume the same host and reconnect | Both remote and offline edits survived; status returned to Synced |

These are focused end-to-end checks, not full app acceptance. Record every later feature group with
its actual interaction result. Screenshots alone do not prove behavior.

## Outstanding constraints

- No paid Apple account: no paid push/distribution acceptance.
- Physical iPhone availability and Personal Team signing are not yet verified. Device-only checks
  remain distinct from simulator coverage.

## Latest integration checkpoint

- The user explicitly removed iPhone Vim from scope. Its isolated unfinished branch is not
  integrated; no mobile Vim controls are presented, even when shared desktop Vim is enabled.
- Shared WorkspaceCore preserves Mac tab/history behavior. Phone explorer, search with honest
  offline coverage, daily/weekly/date navigation, structural operations and recovery/export UI
  are integrated. Offline daily/weekly creation uses cached templates and local dates; navigation restoration is implemented.
- Receipt-aware actions now reject a connection-generation change during durable preparation;
  the regression includes disconnect followed by reconnect before dispatch. Four focused tests pass.
- CUA passed note creation and real typing, back/forward with text retained, content search showing
  human line 2 for wire line 1, and shared theme Save acknowledged by the host. Appearance settings
  contain no Vim controls. Accessible rename and soft-delete also passed; the original text was verified in the synthetic
  host’s Trash. Remaining recovery and full settings interactions are still in progress.
- CUA launch caught stale incremental protocol witnesses after additive Client changes. A clean
  rebuild restored launch with the same saved connection and notes; fresh CI simulator tests passed.
- Latest web CI passed. Native packages, editor, app, shared iOS and iPhone jobs passed. Its one
  relay integration failure assumed a transient connecting event survives coalescing; the corrected
  assertion passed locally against real isolated daemons, with the full native rerun still due. The full repository check passed after reducing package
  test concurrency for an unchanged connector timing test; its budget was not widened.
- Standalone drawing creation/open/editing now uses the durable repository, shared tabs and
  structural transactions. Recovery presents exact local/host files and preserves originals.
  Gestures defer remote scene adoption; background checkpoint drains those arrivals. A malformed
  incoming file retains both its original bytes and the in-progress valid local canvas, with no
  automatic overwrite. Host echoes compare serialized scenes, avoiding repeated saves caused by
  decoder bookkeeping. Native regressions cover those cases and stale incoming revisions.
- Controller-owned drawing callbacks survive view disposal. The simulator suite passes native
  touch creation/undo/redo, mounted-canvas hit testing and the drawing persistence regressions.
  CUA passed text creation, save, undo/redo, offline edit, process termination/relaunch, and
  reconnection with a disjoint remote shape; both sides were visibly retained and verified in the
  synthetic host file. CUA drag did not create a rectangle despite the real-touch XCUITest passing;
  keep that discrepancy open rather than claiming a CUA drag pass.
- Binary files now preserve bytes through all storage providers and sync-service blobs. The daemon
  exposes authenticated conditional file reads/uploads/soft deletion (5 MiB); only sniffed raster
  types display inline. Swift downloads are bounded while streaming. Deep sync/property tests and
  full repository checks pass. Native content caching uses bounded transactional SQLite blobs,
  explicit pins/missing states and durable generation tickets; UI wiring remains in progress.
- Shared drawing scene merge preserves local-only canvas settings and merges disjoint remote keys.
  Native SVG transfer is bounded and rejects unsupported active constructs; full visual parity
  remains under review. The unused mobile editor Vim dependency has also been removed.
- Latest combined `pnpm check` passed after serial package execution; concurrent CLI/body-limit
  timing failures passed serially without changing budgets. A new branch-wide CI run is due.

- Navigation, open/closed notes and back/forward history now persist with bounded snapshots.
  Caret and scroll positions restore after layout without overriding later scrolling. Shared
  navigation tests (12), the native suite and lint pass. CUA confirmed the selected Welcome note
  after termination/relaunch and Back returning to the prior daily note with its text intact.

- Offline Inbox/conversations/artifacts now hydrate before connecting. Cached controls remain
  disabled until fresh authoritative responses arrive; bounded previews and explicit pins are
  surfaced. Store replacement and suspension flush content and composer caches locally.
- Offline daily/weekly creation freezes the template and phone date. Known undownloaded notes
  and missing configured templates cannot become blank replacements. Templates download on
  connection/settings refresh. All 99 MobileKit tests and the combined signed Simulator suite pass.
- Native drawing precision/elbow routing checkpoints are integrated. The iPhone icon now uses
  the existing checkbox artwork with an opaque full-bleed background, visually inspected.

Next app work: drawing embeds and attachment/content rendering; living-list badges/activity;
download controls; cache/intent/notification
composition; full recovery, accessibility, keyboard and computer-use acceptance. Standalone
drawings and foundational APIs do not complete those remaining features.
