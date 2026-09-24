# Cross-platform plan: web, macOS, iPhone

Daily Do List is designed as one product across three surfaces with **one UI codebase**
(`apps/web`). Only the web app ships today; the native apps are thin shells planned around it.

| Surface | Shell | Where the agent runs | Status |
| --- | --- | --- | --- |
| Web | Browser → daemon on `127.0.0.1` | Local daemon | ✅ working |
| macOS | Tauri 2 window + bundled daemon (sidecar) | Local daemon (full capabilities: shell, browser, desktop) | planned — `apps/desktop` |
| iPhone | Tauri 2 iOS | Your Mac's daemon over an authenticated tunnel, or a cloud daemon (`cloud` execution provider) | planned — `apps/mobile` |

## Why this works without a rewrite

- **The UI is platform-neutral.** Everything talks to the backend through the `DaemonClient`
  interface (`apps/web/src/api/client.ts`) with an explicit base URL and token, so a native shell
  just passes its daemon's address. No UI code assumes the page origin is the daemon.
- **The protocol is explicit.** `packages/core/src/protocol.ts` defines every REST route, body and
  WebSocket event. Any client (WebView, native widget, CLI) can implement it.
- **Domain logic is pure.** `@ddl/core` has no dependencies and no Node/DOM APIs, so daily-note
  math, task parsing and identity tracking behave identically everywhere.
- **Hands are a provider.** The agent loop only needs an `ExecutionProvider`. On macOS it's the
  local one; for iPhone-only use, a `cloud` provider (remote sandbox with browser/desktop) plugs in
  without touching the orchestrator.
- **Storage and sync are providers.** A vault can live on disk, in S3 (next), or be mirrored to an
  iCloud Drive folder via `SyncEngine`, which is how notes reach the phone.

## macOS app (apps/desktop)

1. Tauri 2 app whose WebView loads the built `apps/web` (or the daemon's URL).
2. The daemon is bundled as a sidecar binary (the esbuild bundle + Node SEA, or `bun build
   --compile`) and started by the app; the token is handed to the WebView via a Tauri command
   instead of an HTML meta tag.
3. Native niceties: global hotkey for today's note, menu-bar status (running agents, pending
   approvals), native notifications for approval requests, launch at login.
4. Browser-reserved shortcuts (`⌘W`, `⌘N`, `⌘⇧W` for the weekly note) become available.
5. Computer use gets a stable app identity for the Accessibility / Screen Recording permissions.

## iPhone app (apps/mobile)

1. Tauri 2 iOS target sharing the same web bundle (responsive layout: single pane, thread as a
   sheet, approvals as native notifications with Approve/Deny actions).
2. Connects to a daemon it does not host: the user's Mac (paired with a QR code carrying the URL
   and a device-scoped token; reachable over Tailscale or a relay) or a cloud daemon.
3. Offline: an IndexedDB-backed `StorageProvider` cache with the same `SyncEngine` semantics, so
   editing works on the subway and merges later.

## Checklist before the first native build

- [ ] Device-scoped tokens and pairing endpoint in the daemon (today there is one local token).
- [ ] Remote access story (Tailscale/relay) with TLS; keep `127.0.0.1` binding the default.
- [ ] Responsive layout pass for narrow screens.
- [ ] `S3StorageProvider` implementation (the stub documents the plan) or iCloud sync target docs.
- [ ] `CloudExecutionProvider` implementation (the stub documents the interface).
