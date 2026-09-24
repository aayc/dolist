# Cross-platform plan: web, macOS, iPhone

Daily Do List is one product across three surfaces that share one daemon and one wire protocol.
The web app (`apps/web`) runs in a browser. The macOS app (`apps/macos`) is a native
SwiftUI/AppKit client of the same daemon. The iPhone app is planned; it will reuse the macOS
app's platform-neutral Swift packages.

| Surface | Client | Where the agent runs | Status |
| --- | --- | --- | --- |
| Web | Browser → daemon on `127.0.0.1` | Local daemon | ✅ working |
| macOS | Native SwiftUI/AppKit app that supervises its own daemon (or attaches to a running one) | Local daemon (full capabilities: shell, browser, desktop) | in progress — `apps/macos` |
| iPhone | Native SwiftUI app reusing `DailyDoListModels`, `DailyDoListClient`, `DailyDoListDomain` and `DailyDoListVim` | Your Mac's daemon over an authenticated tunnel, or a cloud daemon (`cloud` execution provider) | planned — `apps/mobile` |

## Why every client can share one backend

- **The web UI is origin-independent.** It talks to the backend through the `DaemonClient`
  interface (`apps/web/src/api/client.ts`) with an explicit base URL and token. No UI code assumes
  the page origin is the daemon.
- **The protocol is explicit.** `packages/core/src/protocol.ts` defines every REST route, body and
  WebSocket event. Any client (WebView, native widget, CLI) can implement it.
- **Native clients speak the same protocol.** `DailyDoListModels` mirrors `protocol.ts` in Swift
  and its tests decode the `@ddl/contract` fixtures, so drift fails CI. `DailyDoListClient`
  implements the same `DaemonClient` surface over REST and WebSocket. Both are Foundation-only and
  build for iOS.
- **Domain logic is pure.** `@ddl/core` has no dependencies and no Node/DOM APIs, so daily-note
  math, task parsing and identity tracking behave identically everywhere.
- **Editor behavior is pinned by vectors.** Vim mode runs `@replit/codemirror-vim` on the web and
  `DailyDoListVim` (a Foundation-only Swift port) natively; both replay the same recorded behavior
  vectors (`packages/editor/test/vim`), so a key sequence does the same thing on every surface.
- **Hands are a provider.** The agent loop only needs an `ExecutionProvider`. On macOS it's the
  local one; for iPhone-only use, a `cloud` provider (remote sandbox with browser/desktop) plugs in
  without touching the orchestrator.
- **Storage and sync are providers.** A vault can live on disk, in S3 (next), or be mirrored to an
  iCloud Drive folder via `SyncEngine`, which is how notes reach the phone.

## macOS app (apps/macos)

A native SwiftUI/AppKit app built from independent Swift packages (see
[apps/macos/README.md](../apps/macos/README.md)):

1. The UI is native: a TextKit markdown editor with live preview and agent badges, threads,
   approval cards, a command palette and settings. It uses the same REST + WebSocket API as the
   web app, through `HTTPDaemonClient`. `--demo` runs it against an in-memory daemon.
2. `DaemonSupervisor` attaches to a running daemon (for example `pnpm dev`) or launches
   `node apps/daemon/dist/main.js` itself, from the app bundle (`build-app.sh --with-daemon`) or a
   checkout. It uses the system Node 24.4+ and reads the token from `$DDL_HOME/daemon-token`. It
   health-checks the daemon, restarts it with backoff after a crash, and stops it (SIGTERM, then
   SIGKILL) when the app quits.
3. Native niceties: a global hotkey for today's note, launch at login, menu-bar status, a Dock
   badge, and native notifications for approval requests.
4. Browser-reserved shortcuts (`⌘W`, `⌘N`, `⌘⇧W` for the weekly note) are available.
5. The daemon runs as the app's child, so computer use asks for Accessibility and Screen
   Recording under the app's identity. The identity stays stable once the app is signed with a
   real certificate; today's builds are signed ad hoc.

## iPhone app (apps/mobile)

1. A native SwiftUI app reusing `DailyDoListModels`, `DailyDoListClient`, `DailyDoListDomain` and
   `DailyDoListVim` (Foundation-only, declared for iOS 17), with a compact UI: single pane, thread
   as a sheet, approvals as native notifications with Approve/Deny actions.
2. Connects to a daemon it does not host: the user's Mac (paired with a QR code carrying the URL
   and a device-scoped token; reachable over Tailscale or a relay) or a cloud daemon.
3. Offline: a local cache of the vault with the same `SyncEngine` semantics, so editing works on
   the subway and merges later.

## Checklist before the iPhone app

- [ ] Device-scoped tokens and pairing endpoint in the daemon (today there is one local token).
- [ ] Remote access story (Tailscale/relay) with TLS; keep `127.0.0.1` binding the default.
- [ ] Compact iPhone layouts for the note, thread and approval views.
- [ ] `S3StorageProvider` implementation (the stub documents the plan) or iCloud sync target docs.
- [ ] `CloudExecutionProvider` implementation (the stub documents the interface).
