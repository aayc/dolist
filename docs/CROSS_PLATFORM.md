# Cross-platform plan: web, macOS, iPhone

Daily Do List is one product across three surfaces that share one daemon and one wire protocol.

| Surface | Client | Where the agent runs | Status |
| --- | --- | --- | --- |
| Web | Browser → daemon | Local daemon | ✅ working |
| macOS | Native SwiftUI/AppKit app that supervises its own daemon (or attaches to a running one) | Local daemon (shell, browser, desktop), or relayed to the always-on machine | ✅ working — [`apps/macos`](../apps/macos/README.md) |
| iPhone | Native SwiftUI app reusing the macOS app's Foundation-only packages | The always-on daemon over a private network ([ALWAYS_ON.md](./ALWAYS_ON.md)), or your Mac's | planned — [plan](../apps/mobile/PLAN.md) |

Why every client can share one backend:

- **The protocol is explicit.** The zod schemas in `packages/contract/src/wire` define every REST
  route, body and WebSocket event ([PROTOCOL.md](./PROTOCOL.md)). The web UI talks to the daemon
  only through its `DaemonClient` with an explicit base URL and credential; `DailyDoListModels`
  mirrors the schemas in Swift and decodes the contract's fixtures, so drift fails CI, and
  `DailyDoListClient` implements the same client over REST and WebSocket. Both Swift packages are
  Foundation-only and build for iOS.
- **Domain logic is pure and pinned.** `@ddl/core` has no runtime dependencies and no Node/DOM
  APIs; its Swift port (`DailyDoListDomain`) replays vectors generated from it, and vim mode on
  every surface replays the same recorded behavior vectors (`packages/editor/test/vim`).
- **Hands and storage are providers.** The agent loop only needs an `ExecutionProvider`, so a
  remote one could serve iPhone-only use without touching the orchestrator; a vault syncs to other
  devices through `SyncEngine` and the sync service.
- **The Mac app is a client like any other.** It uses the same REST + WebSocket API through
  `HTTPDaemonClient`; its daemon runs as the app's child, so computer use asks for permissions
  under the app's identity.
