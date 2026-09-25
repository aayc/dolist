# apps/mobile — iPhone app (planned)

A native SwiftUI iPhone app that reuses the macOS app's Foundation-only Swift packages and talks
to a daemon it doesn't host: your Mac's, or the always-on one
([docs/ALWAYS_ON.md](../../docs/ALWAYS_ON.md)). Not implemented yet; the web app covers mobile use
for now, and this folder is intentionally not a workspace package until it has code.

The plan (decisions, architecture, daemon prerequisites, testing, build order):
[PLAN.md](./PLAN.md). The cross-platform picture: [docs/CROSS_PLATFORM.md](../../docs/CROSS_PLATFORM.md).
