# iPhone app: plan

Status: planned, not started; the web app covers mobile use for now. It was written against `main`
in September 2026, so re-check the package lists before starting.

## Decisions so far

- **Native Swift/SwiftUI**, not a web shell. It reuses the macOS app's Foundation-only packages
  and speaks the same wire protocol as every other client (`packages/contract/src/wire`).
- **Apple account: a free Apple ID.** The app is installed from Xcode (builds expire after 7
  days). No push notifications (APNs) and no TestFlight until there is a paid developer account;
  notifications are designed so APNs plugs in later without changing the app's model.
- **Extra in scope: Siri and Shortcuts** ("add … to my do list"). Widgets, a share extension,
  iPad layout and Live Activities are deferred.
- **Network: undecided.** Tailscale on the Mac and the phone is the recommendation (private,
  encrypted, works anywhere); home Wi-Fi only is the alternative.
- **Toolchain: full Xcode**, used only through this app's scripts via `DEVELOPER_DIR`, so the
  Command Line Tools stay the default for the macOS app's scripts.

## What the app does

A compact, single-pane UI with four tabs: **Today** (today's note in a native markdown editor with
live preview, checkboxes, agent badges and marked agent lines, other days a swipe away, a keyboard
accessory bar), **Notes** (the tree, recents, search, create/rename/move, soft delete), **Inbox**
(approvals first, the orchestrator's chat pinned, task threads and routines, with the Mac's chat
polish, inline approval cards, artifacts and the live agent view) and **Settings**. Plus pairing
(a QR code or a pairing link), offline reading and editing, local notifications, Siri and
Shortcuts, and a demo mode against a demo daemon, like the Mac's `--demo`, for UI tests.

## Architecture

```
 app target (thin: @main, Info.plist, assets, App Intents)
   └─ DailyDoListMobileUI        iOS-only SwiftUI screens, editor view, scanner, notifications
        └─ DailyDoListMobileKit  multiplatform stores: connection, notes, inbox, approvals,
             │                   routines, settings, offline cache and outbox, event routing
             ├─ shared cores     DailyDoListMarkdown · DailyDoListAgentCore · DailyDoListWorkspaceCore
             └─ existing         DailyDoListModels · DailyDoListClient · DailyDoListDomain · DailyDoListVim
```

- **Everything testable lives in multiplatform packages** that build for iOS and macOS, so their
  tests run with `swift test` on any Mac; only what needs UIKit (the text view, the scanner,
  notifications, Keychain classes, background tasks) is iOS-only.
- **The app target stays thin**: the Xcode project is generated (XcodeGen, pinned in CI, not
  committed), and signing settings live in a gitignored local xcconfig.
- **Shared cores come out of the macOS packages first**, so iOS reuses tested logic:
  `DailyDoListMarkdown` (the editor's tokenizer), `DailyDoListAgentCore` (agent state and events,
  the chat logic, the pure support files) and `DailyDoListWorkspaceCore` (the portable stores:
  notes, vault, connection, search, save state, merge and badges). The macOS packages then depend
  on them.
- **The editor** is a `UITextView` on TextKit 2 styled from `DailyDoListMarkdown` tokens; agent
  edits merge into unsaved typing with the Domain's `TextMerge` (invariant 7), and the keystroke
  path stays O(line) (invariant 8).

## Daemon prerequisites

Remote access, device tokens and pairing are built ([ALWAYS_ON.md](../../docs/ALWAYS_ON.md)), and
the Swift client authenticates remote WebSockets by header. Still to do: a QR code on the pairing
screens (`POST /api/pairing-codes` already returns the URL for it), and an atomic append to a
daily note for Siri, so "add X to my do list" can't race an open editor (protocol, contract and
`DailyDoListModels` together). Later, with a paid account: a push sender in the daemon (APNs), a
route to register the phone's push token, and pushes for approvals, finished threads and routine
notifications.

## Offline, notifications, Siri, security

- **The phone is a client, not a sync device.** It caches the tree, recent notes and threads (with
  iOS Data Protection) and queues offline edits with the version they were based on; on reconnect a
  conflict is three-way merged with `TextMerge`, else written as a conflict copy. Approvals and
  threads are read-only offline: deciding an approval needs a live connection.
- **Notifications** on a free account are local, for events that arrive while the app runs or
  refreshes in the background; Approve/Deny actions require unlocking (high-risk ones can ask for
  Face ID). An APNs source plugs into the same router later.
- **Siri and Shortcuts** (App Intents, no entitlement needed; confirm when building): "Add … to my
  do list" (the daemon's atomic append), "Open today's note", "What's waiting for my approval?".
  No intent ever approves or denies anything.
- **Security:** the device token lives in the Keychain (this device only), never in defaults, files
  or logs; logs carry method names, durations and error codes only. App Transport Security stays at
  its defaults. The QR code never contains a token. "Sign out of this daemon" deletes the token, the
  cache and the outbox. No team id or device names in the repo.

## Toolchain and testing

`apps/mobile/scripts/` (`generate.sh`, `test.sh [Package|app|ui]`, `build.sh`, `run-sim.sh`) set
`DEVELOPER_DIR` for their own commands; parallel test runs each create and delete their own
simulator. CI gets a mobile job on the macOS runner (generate, package tests on macOS and a
simulator, UI tests, an unsigned build). Tests: the multiplatform packages with `FakeDaemonClient`
and fakes; the iOS packages on a simulator; XCUITest journeys against demo mode with accessibility
audits, Dynamic Type and dark mode; integration tests against the real daemon (pairing, revocation,
offline merge, an approval from the phone); performance budgets in `docs/PERFORMANCE.md`. Journeys
to add to `docs/USER_JOURNEYS.md`: pair a phone; add a task on the go; approve from a notification;
edit offline and merge; "Hey Siri, add … to my do list".

## Build order

Each phase ends with tests, docs and CI green; phase 0 and the daemon work can run in parallel.

0. **Foundations.** Extract the three shared cores; the mobile skeleton (packages, XcodeGen spec,
   scripts, CI job, demo mode, tab shell, one UI test); the QR code and the atomic append.
1. **Core features.** Connection and pairing; the editor; Today and Notes; Inbox and threads;
   approvals; orchestrator chat; settings.
2. **Depth.** The editor's agent integration; offline cache and outbox; notifications and
   background refresh; live agent view and artifacts; routines; Siri and Shortcuts.
3. **Quality.** UI test journeys and accessibility audits, integration tests, performance budgets,
   docs, and a security review of pairing, storage and notifications.

With parallel agents: about fifteen streams in four waves matching the phases, merged by one lead
into `feat/iphone`. The skeleton gives each stream its own placeholder screen and store to replace,
so streams rarely touch the same files (the tab shell and `Package.swift` go through the lead); at
most about six run simulator tests at once on a 14-core Mac.

## Open questions

- Tailscale, home Wi-Fi, or both.
- Whether to get a paid developer account for push and TestFlight.
- Minimum iOS version: the shared packages declare iOS 17; raising it would allow newer SwiftUI
  and TextKit APIs.
- iPad (split view, hardware keyboard, vim through `DailyDoListVim`), widgets, a share extension
  and Live Activities, when they come back into scope.
