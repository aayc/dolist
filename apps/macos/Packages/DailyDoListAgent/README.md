# Agent state and native views

Three products share one state machine:

- `DailyDoListAgentCore`: Foundation/Observation reducers, `AgentStore`, refresh race guards,
  approvals, routine actions/drafts, chat grouping/scroll/reveal rules, markdown parsing and safe
  artifact/link helpers. It builds for macOS 14 and iOS 17.
- `DailyDoListAgent`: existing macOS views, notifications, AppKit rich text and image adapters.
  It re-exports the core, preserving the app's existing imports.
- `DailyDoListMobileAgent`: native SwiftUI/UIKit Inbox, task/orchestrator conversation, approval,
  routines, artifact and live-surface views. It also re-exports the core.

`DailyDoListAgentTestSupport` remains a macOS test-only product. Existing reducer, store, chat,
markdown, safety and hosted Mac view tests exercise the extracted implementation directly.

## iPhone integration

Create one `AgentStore` per connected workspace. Feed it server events with `handle(_:)` and
refresh on launch/reconnect. The mobile host owns transport lifecycle and durable storage;
the agent views never establish their own connection or start a daemon.

```swift
MobileInboxView(
  store: agentStore,
  actionsEnabled: connectionHasCurrentWorkspaceAuthority,
  hostName: connectedHostName,
  drafts: MobileAgentDrafts(
    load: { threadId in repository.replyDraft(threadId) },
    save: { threadId, text in repository.saveReplyDraft(threadId, text) }),
  openNote: { path, line in workspace.open(path, line: line) })
```

`MobileInboxView` owns its `NavigationStack`. `MobileThreadView` can also be pushed by the host
or placed in a sheet's navigation stack. `MobileRoutinesView`, `MobileApprovalCard`,
`MobileArtifactView` and `MobileSurfaceView` are independently reusable.

Actions default to disabled. The host enables them only after authenticated connection and
workspace validation; views also honor the daemon's relay read-only state. `hostName` identifies
the connected daemon, while approval cards prefer the reported execution machine when relayed.
The reviewed card and execution machine must still match when a decision is sent. Approval
decisions are never queued offline. Broader task/always grants require an explicit scope review.

`MobileAgentDrafts.save(threadId, text)` must enqueue **local**, workspace-scoped persistence;
it must not perform disk or network work synchronously on input. Reply text is retained until
the daemon accepts it, including when a send fails. Without these callbacks, navigation retains
drafts only for the lifetime of `AgentStore`. File editing, structural deletion and recovery use
the host's ordinary note repository (`openNote`), including routine markdown files.

Only visibly active conversation views mark threads read. Surface subscriptions are balanced on
appearance/disappearance and scene activation. The core stores raw frames; each platform owns
its decoded images. iPhone decoding runs on a serial worker, limits source dimensions/bytes and
renders a thumbnail capped at 2,048 pixels per side. Previewable artifacts are limited to 32 MB.
HTML receives no token or JavaScript bridge, uses nonpersistent website data, disables scripts,
restricts subresources with CSP and rejects navigation. Saving/sharing requires an explicit action.

## Verification and remaining integration

Run `apps/macos/scripts/test.sh DailyDoListAgent` from the repository root for existing and new
core/Mac regressions. In this package directory, `xcodebuild build -scheme DailyDoListMobileAgent
-destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO` checks the phone product without a
developer membership; Simulator can be selected with `generic/platform=iOS Simulator`.

The initial mobile product has compile coverage, not a completed phone release. The integrator
still owns real-daemon and computer-use journeys, persistent thread/artifact caches and reply
draft wiring, mobile lifecycle tests, receipt-aware retries, notification catch-up, hardware
Return behavior, incremental row/render performance and accessibility/device profiling. Those
remain acceptance work in `apps/mobile/PLAN.md`; successful SDK builds do not replace them.
