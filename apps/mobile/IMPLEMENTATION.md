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
| 1 Shared logic | In progress | EditorCore extracted and Mac editor tests pass; AgentCore stream active; workspace/drawing extraction remains |
| 2 Connection and durability | In progress | Separate identity/capture and durable repository streams; Keychain/pairing/lifecycle integration remains |
| 3 Notes/editor | Not started | Entire notes/editing/navigation/search and living-list matrix |
| 4 Agent workspace | Not started | Chat/orchestrator/approval/routine/artifact/surface/settings/host matrix |
| 5 Drawings/content | Not started | Native touch tools/parity, embeds, attachment B0 and rendering P |
| 6 Vim/phone integration | Not started | Full vectors, keyboard/accessory, capture/Siri, local notification catch-up |
| 7 Hardening | Not started | All automated gates, computer-use feature matrix, recovery/accessibility/performance |
| 8 Paid push/distribution | Not applicable | User has no paid account; keep optional design separate |

## Active ownership and next actions

The written stream scope is `docs/specs/iphone-implementation-streams.md`. The integrator owns
`codex/iphone-app`; `codex/iphone-backend`, `codex/iphone-repository` and `codex/iphone-agent`
are isolated parallel streams. Integrate reviewed commits and rerun affected tests.

1. Finish the foundation checkpoint and integrate real pairing/connection lifecycle.
2. Integrate workspace identity/capture contracts and durable repository before enabling replay.
3. Compose full notes and agent UI, then drawing/content and Vim/phone integration.
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
  Compare the baseline before attributing it to the extraction; do not waive or widen the budget.
- `pnpm check` and changed-file lint pass for the foundation checkpoint.
- This validates a foundation only. The connection screen is still provisional and the full
  feature and physical-device matrices remain open.

## Computer-use evidence

| Build / device | Synthetic scenario | Observed result / follow-up |
| --- | --- | --- |
| Foundation working tree / iPhone 16 Plus, iOS 18.5 | Toggle checkbox, switch source/preview, type task and press Return | Markdown preserved; checkbox changed; next task prefix inserted |
| Same | Tap into prose and type | First check found a recognizer consuming editor taps; restricted recognizer to checkbox hits, then real typing passed |
| Same, corrected build | Type on a line containing emoji | First check found disappearing emoji glyph; deferred style transaction plus pixel regression fixed it; repeated actual input shows leaf preserved |

These are focused editor checks, not full app acceptance. Record every later feature group with
its actual interaction result. Screenshots alone do not prove behavior.

## Outstanding constraints

- No paid Apple account: no paid push/distribution acceptance.
- Physical iPhone availability and Personal Team signing are not yet verified. Device-only checks
  remain distinct from simulator coverage.
