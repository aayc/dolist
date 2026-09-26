# iPhone app: plan

Status: planned, not started. The web app covers mobile use for now. This is the plan to pick up
when we build the native app; it was written against `main` in September 2026, so re-check the
package lists below before starting.

## Decisions so far

- **Native Swift/SwiftUI**, not a web shell. It reuses the macOS app's Foundation-only packages
  and speaks the same wire protocol as every other client (`packages/core/src/protocol.ts`).
- **Apple account: a free Apple ID.** The app is installed from Xcode (builds expire after 7
  days). No push notifications (APNs) and no TestFlight until there is a paid developer account;
  notifications are designed so APNs plugs in later without changing the app's model.
- **Extra in scope: Siri and Shortcuts** ("add … to my do list"). Widgets, a share extension,
  iPad layout and Live Activities are deferred.
- **Network: undecided.** Tailscale on the Mac and the phone is the recommendation (private,
  encrypted, works anywhere); home Wi-Fi only is the alternative. Either way the daemon needs
  phase 1 of [docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md) first.
- **Toolchain: full Xcode**, used only through this app's scripts via `DEVELOPER_DIR`, so the
  Command Line Tools stay the default for the macOS app's scripts (see "Toolchain").

## What the app does

Compact, single-pane iPhone UI with four tabs:

- **Today.** Today's note in a native markdown editor: live preview, task checkboxes, agent badges
  on tasks (status, tap to open the thread), the agent's lines visibly marked. Swipe or pick a date
  for other daily notes. A keyboard accessory bar: toggle task, indent/outdent, bullet, link,
  undo/redo, dismiss.
- **Notes.** The vault tree, recent notes, fuzzy search, create/rename/move, soft delete (to
  `.trash/`, as everywhere).
- **Inbox.** Pending approvals first, the orchestrator's chat pinned, task threads grouped as on
  the Mac, and routines, each with its own inbox of runs (once routines is on `main`). A thread is
  the polished chat: typing reveal, activity row, "Used N tools" groups, composer with an outbox,
  Stop and Retry, inline approval cards, artifacts (images, markdown, HTML under the existing
  artifact policy) and the live agent view (browser and computer frames while watching).
- **Settings.** Connection and paired daemon, agent on/off, harness and model, approval policy,
  daily notes, appearance, diagnostics.

Plus pairing (scan a QR code or paste a pairing link), offline reading and editing, local
notifications, Siri and Shortcuts, and a demo mode on the in-memory daemon for previews, UI tests
and screenshots.

## Architecture

```
 app target (thin: @main, Info.plist, assets, App Intents)
   └─ DailyDoListMobileUI        iOS-only SwiftUI screens, editor view, scanner, notifications
        └─ DailyDoListMobileKit  multiplatform stores: connection, notes, inbox, approvals,
             │                   routines, settings, offline cache and outbox, event routing
             ├─ shared cores     DailyDoListMarkdown · DailyDoListAgentCore · DailyDoListWorkspaceCore
             └─ existing         DailyDoListModels · DailyDoListClient · DailyDoListDomain · DailyDoListVim
```

- **Everything testable lives in multiplatform packages.** `DailyDoListMobileKit` builds for iOS
  and macOS, so its tests run with `swift test` on any Mac (Command Line Tools are enough), and CI
  also builds it for iOS. Only what truly needs UIKit (the text view, the camera scanner,
  notifications, Keychain accessibility classes, background tasks) is iOS-only.
- **The app target stays thin.** All code is in packages; the Xcode project is generated from a
  spec (XcodeGen `project.yml`, pinned in CI), and the generated `.xcodeproj` is not committed.
  Signing settings (team id) live in a gitignored local xcconfig, never in the repo.
- **Shared cores come out of the macOS packages first** (phase 0), so iOS reuses tested logic
  instead of copying it. All of these are Foundation or Observation only today:
  - `DailyDoListMarkdown`: the editor's tokenizer (`DailyDoListEditor/Tokenizer`: markdown and
    inline tokens, agent markers, link targets, line prefixes).
  - `DailyDoListAgentCore`: agent state and events (`DailyDoListAgent/State`), the chat logic
    (`RevealPacing`, `RevealedText`, `ChatActivity`, `ChatItems`, `ComposerModel`,
    `MessageMerge`), and the pure support files (`AgentFormat`, `MarkdownChunks`,
    `MarkdownRenderer`, `LinkPreview`, `HTMLArtifactPolicy`).
  - `DailyDoListWorkspaceCore`: the app shell's portable stores (`NotesStore`, `VaultStore`,
    `ConnectionStore`, `SearchModel`, `SaveState`) and, once the tokenizer moved,
    `MergeEdits` and `BadgeBuilder`.

  The macOS packages then depend on them; their existing tests keep covering the moved code, and
  CI's "Shared packages build for iOS" step adds them.
- **The editor** is a `UITextView` on TextKit 2, styled from `DailyDoListMarkdown` tokens (the
  macOS editor's layout code is AppKit/TextKit 1 and isn't reused). Agent edits merge into unsaved
  typing with the Domain's `TextMerge`, keeping the selection, as on the Mac (invariant 7). The
  keystroke path stays O(line) (invariant 8): styling is incremental per edited paragraph, saving
  is debounced, no network per keystroke.

## Daemon prerequisites

Phase 1 of [docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md) (remote access) is built:

- Remote hosts, device tokens and pairing: Settings → Devices on web and Mac issues a short,
  single-use pairing code (never a token) and shows the address to open; the phone exchanges the
  code for its own device token (`POST /api/pair`), which Settings can revoke.
- WebSocket authentication for remote clients: the Swift client sends
  `Authorization: Bearer <token>` on the upgrade to any daemon that isn't on loopback, and puts
  the token in the URL (`?token=`) only on loopback, where remote hosts refuse it anyway.

Still to do:

- A QR code on the pairing screens, with the daemon URL and the pairing code
  (`POST /api/pairing-codes` already returns the URL for it).
- An atomic append to a daily note (for Siri: "add X to my do list" must not race with an open
  editor), in the protocol, the contract and `DailyDoListModels` in the same change.
- Later, with a paid account: a push sender behind an interface in the daemon (APNs, token auth),
  a route for the phone to register its push token, and pushes for approvals, finished threads
  and routine notifications.

## Offline and sync

The phone is a client of a daemon, not a sync device:

- **Cache:** the tree, today's and recent daily notes, notes opened recently, thread summaries and
  recent messages, stored with iOS Data Protection.
- **Outbox:** offline edits are queued with the version they were based on. On reconnect, each
  write uses `baseVersion`; on a conflict the phone three-way merges with `TextMerge` against the
  cached base, and if that fails it writes a conflict copy (the same naming as the sync engine's).
- **Read-only offline:** approvals and threads show but can't be acted on. Deciding an approval
  always needs a live connection.
- **Foreground resync:** iOS drops the WebSocket in the background; on return the app reconnects
  (the client's backoff) and refreshes what changed.

## Notifications (free account)

- Local notifications for events that arrive while the app runs or refreshes in the background
  (`BGAppRefreshTask`; iOS decides how often, so it isn't reliable). Tapping one opens the thread
  or the approval.
- Approve/Deny actions on a notification require unlocking the phone
  (`.authenticationRequired`), and high-risk approvals can ask for Face ID in the app (a
  setting).
- The same notification router gets an APNs source later; screens don't change.

## Siri and Shortcuts

App Intents with App Shortcuts phrases (no special entitlement, so they work on a free account;
confirm when building):

- "Add … to my do list": appends a task to today's note through the daemon's atomic append. It's
  the user's own task, so the orchestrator picks it up as usual.
- "Open today's note" and "What's waiting for my approval?" (a count and a list; opens the Inbox).
- No intent ever approves or denies anything: approvals stay in the app, behind unlock.

## Security

- The device token lives in the Keychain (this device only, available after first unlock), never
  in defaults, files or logs. Logs carry method names, durations and error codes only, as in
  `ddl-computer`.
- HTTPS for anything that isn't loopback: App Transport Security stays at its defaults, with no
  exceptions.
- Pairing codes are short-lived and single-use; the QR code never contains a token.
- The offline cache uses Data Protection; "Sign out of this daemon" deletes the token, the cache
  and the outbox.
- Nothing personal in the repo: no team id, bundle id suffixes or device names; demo data is
  synthetic (the in-memory daemon's seed).

## Toolchain

- Full Xcode (App Store) is required for the iOS SDK, the simulator, UI tests and installing on a
  phone. The mobile scripts set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for
  their own commands; the macOS app's scripts keep working with the Command Line Tools.
- `apps/mobile/scripts/`: `generate.sh` (XcodeGen), `test.sh [Package|app|ui]`, `build.sh`,
  `run-sim.sh` (the simulator, demo mode by default).
- Parallel test runs each get their own simulator (`xcrun simctl create ddl-<name> …`), deleted
  afterwards, so runs never share a device.
- CI: a mobile job on the macOS runner that generates the project, runs the multiplatform package
  tests, the iOS package tests on a simulator, the UI tests, and builds the app unsigned.

## Testing

- **Multiplatform packages:** Swift Testing with `InMemoryDaemonClient` and fakes (clock,
  Keychain, file store, reachability), run on macOS: stores, event routing, outbox and merge,
  offline cache, pairing state machine, intents' logic.
- **iOS packages** (simulator, `xcodebuild test`): the editor (typing, task toggles, badges,
  merging remote edits into typing, undo), the scanner's parsing, notification actions, Keychain.
- **UI tests** (XCUITest against demo mode): the journeys below with the real keyboard, plus
  `performAccessibilityAudit()` on every screen, Dynamic Type sizes and dark mode.
- **Integration** (macOS host, real daemon with the mock agent, like `apps/macos/IntegrationTests`):
  pairing against a configured remote host, a revoked device cut off, offline edits merged on
  reconnect, an approval decided from the phone.
- **Performance budgets** in `docs/PERFORMANCE.md`: keystroke latency in a large note, opening
  today's note, cold launch.

Journeys to add to `docs/USER_JOURNEYS.md`: pair a phone; add a task on the go and watch the agent
pick it up; approve a risky action from a notification; edit offline on the subway and merge
later; "Hey Siri, add … to my do list".

## Build order

Each phase ends with tests, docs and CI green. Phases 0 and the daemon work can run in parallel.

0. **Foundations.** Extract the three shared cores from the macOS packages; the mobile skeleton
   (packages, XcodeGen spec, scripts, CI job, demo mode, tab shell with placeholder screens, one
   UI test); what's left of the daemon prerequisites (above: the QR code and the atomic append).
1. **Core features.** Connection and pairing; the editor; Today and Notes; Inbox and threads;
   approvals; orchestrator chat; settings.
2. **Depth.** The editor's agent integration (badges, marked lines, merging into typing, the
   accessory bar); offline cache and outbox; notifications and background refresh; live agent
   view and artifacts; routines; Siri and Shortcuts.
3. **Quality.** The UI test journeys and accessibility audits, integration tests against the real
   daemon, performance budgets, docs, and a security review of pairing, storage and notifications.

## Running it with parallel agents

The work splits into about fifteen independent streams, each on its own branch and worktree,
merged by one lead into a `feat/iphone` branch:

| Wave | Streams |
| --- | --- |
| 0 | shared cores extraction · mobile skeleton · pairing QR code and atomic daily-note append (daemon, web, Mac) |
| 1 | connection and pairing · editor core · Today and Notes · Inbox and threads · approvals · orchestrator chat · settings |
| 2 | editor agent integration · offline and outbox · notifications · live view and artifacts · routines · Siri and Shortcuts |
| 3 | UI tests and accessibility · integration tests · performance, docs and security review |

- The skeleton gives each stream its own placeholder screen and store file to replace, so streams
  rarely touch the same files; the tab shell and `Package.swift` changes go through the lead.
- At most about six streams run simulator tests at once on a 14-core Mac; each uses its own
  simulator.
- Streams commit each working piece on their branch and never push, merge or rebase; the lead
  merges, runs the full matrix, pushes and dispatches CI.

## Open questions

- Tailscale, home Wi-Fi, or both (see "Decisions so far").
- Whether to get a paid developer account for push and TestFlight.
- Minimum iOS version: the shared packages declare iOS 17. Raising it would allow newer SwiftUI
  and TextKit APIs.
- iPad (split view, hardware keyboard, vim through `DailyDoListVim`), widgets, a share extension
  and Live Activities, when they come back into scope.
