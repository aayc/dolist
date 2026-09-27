# Native iPhone implementation handoff

## Durable user instruction (2026-09-27)

The user explicitly authorized full and complete native iPhone development, superseding the
previous planning-only request. They do not have a paid Apple developer account. They will be
away for several days and asked us to keep working until everything is implemented and tested,
including thorough computer-use checks of all features. On the same day they explicitly authorized
many subagents to accelerate implementation. Preserve these instructions through
compaction. Do not stop at a prototype or declare unverified features complete.

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
| 1 Shared logic | In progress | EditorCore extracted and Mac editor tests pass; AgentCore and DrawingCore extracted; workspace/shared navigation work remains |
| 2 Connection and durability | In progress | Workspace identity/capture/receipt protocols and durable caches integrated; real Keychain/manual pairing and offline relaunch/merge verified; broader recovery matrix remains |
| 3 Notes/editor | In progress | Today/ordinary notes/creation/editing and captures work; full navigation/search/living-list/content matrix remains |
| 4 Agent workspace | In progress | Shared AgentCore and native screens integrated; Inbox/result/artifact checked; durable receipts wiring, caches, settings/hosts and full action CUA remain |
| 5 Drawings/content | In progress | Shared native canvas, images and arrangement implemented; app persistence/embeds and remaining parity/B0/P remain |
| 6 Vim/phone integration | Not started | Full vectors, keyboard/accessory, capture/Siri, local notification catch-up |
| 7 Hardening | Not started | All automated gates, computer-use feature matrix, recovery/accessibility/performance |
| 8 Paid push/distribution | Not applicable | User has no paid account; keep optional design separate |

## Active ownership and next actions

The written stream scope is `docs/specs/iphone-implementation-streams.md`. The integrator owns
`codex/iphone-app`; `codex/iphone-backend`, `codex/iphone-repository` and `codex/iphone-agent`
are isolated parallel streams. The agent UI stream continued as `codex/iphone-drawing` and now owns native settings/host UI. The backend stream is adding notification catch-up and receipt-aware actions; repository is adding structural transactions/export/forget. Integrate reviewed commits and rerun affected tests.

1. Finish app composition with durable composers, receipt-aware agent actions, full settings and host controls.
2. Integrate structural/recovery UI, cached content, drawings and complete notes navigation/search.
3. Complete editor living-list/content parity, Vim, Siri/capture and notification integration.
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
