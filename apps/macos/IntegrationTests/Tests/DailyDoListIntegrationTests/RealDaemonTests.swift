import Testing

/// The integration tests that share one real daemon (mock agent), which `DaemonSupervisor`
/// launches before the first test and stops after the last. Tests run one at a time and use their
/// own notes, so they don't depend on each other's order. Suites that start daemons of their own
/// (placement, the relay, the Obsidian import) are top-level, so they run alongside this one.
@Suite(
  "Real daemon", .serialized, .realDaemon,
  .enabled(IntegrationEnvironment.skipReason) { await IntegrationEnvironment.isAvailable() })
struct RealDaemonTests {}
