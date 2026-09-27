# Native iPhone implementation handoff

## Durable user instruction (2026-09-27)

The user explicitly authorized full and complete native iPhone development, superseding the
previous planning-only request. They do not have a paid Apple developer account. They will be
away for several days and asked us to keep working until everything is implemented and tested,
including thorough computer-use checks of all features. Preserve these instructions through
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
| 0 Foundations | In progress | Generated app, simulator launch, editor spike, entitlement/device distinction |
| 1 Shared logic | Not started | Editor/agent/workspace/drawing cores, Mac regressions, iOS builds |
| 2 Connection and durability | Not started | Identity/Keychain/QR, offline repository/outbox, lifecycle/recovery |
| 3 Notes/editor | Not started | Entire notes/editing/navigation/search and living-list matrix |
| 4 Agent workspace | Not started | Chat/orchestrator/approval/routine/artifact/surface/settings/host matrix |
| 5 Drawings/content | Not started | Native touch tools/parity, embeds, attachment B0 and rendering P |
| 6 Vim/phone integration | Not started | Full vectors, keyboard/accessory, capture/Siri, local notification catch-up |
| 7 Hardening | Not started | All automated gates, computer-use feature matrix, recovery/accessibility/performance |
| 8 Paid push/distribution | Not applicable | User has no paid account; keep optional design separate |

## Next actions

1. Generate the app/test project and prove a real iPhone simulator build/launch with local packages.
2. Extract shared Foundation editor logic without forking behavior; run existing Mac tests.
3. Add identity and capture/receipt contracts before allowing durable offline writes to replay.
4. Build the repository and real UI against an isolated mock-agent daemon, then advance the plan.
5. Add a row to the computer-use evidence table for each feature group when actual checks run.

## Validation evidence

- Environment inventory: iOS 18.5 simulator runtime available; no mobile code has been tested yet.
- Planning docs previously passed hygiene/secret checks. Prior full-check formatter/sandbox issues
  were addressed by the independent Mac setup task; rerun checks for implementation changes.

## Computer-use evidence

No mobile feature checks performed yet. Record the build/commit, simulator, synthetic scenario,
observed result and follow-up issue for each feature group. Do not replace interaction checks
with screenshots or claim screenshots alone prove behavior.

## Outstanding constraints

- No paid Apple account: no paid push/distribution acceptance.
- Physical iPhone availability and Personal Team signing are not yet verified. Device-only checks
  remain distinct from simulator coverage.
