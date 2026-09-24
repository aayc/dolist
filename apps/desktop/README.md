# apps/desktop — macOS app (planned)

A Tauri 2 shell around `apps/web` with the daemon bundled as a sidecar. Not implemented yet; this
folder is intentionally not a workspace package until it has code.

See [docs/CROSS_PLATFORM.md](../../docs/CROSS_PLATFORM.md) for the plan: sidecar daemon, token
handoff via a Tauri command, global hotkeys, menu-bar status, native approval notifications, and a
stable app identity for macOS privacy permissions (computer use).
