import Testing

/// Every integration test runs in this suite, against one real daemon (mock agent) that
/// `DaemonSupervisor` launches before the first test and stops after the last. Tests run one at a
/// time and use their own notes, so they don't depend on each other's order.
@Suite(
  "Real daemon", .serialized, .realDaemon,
  .enabled(IntegrationEnvironment.skipReason) { await IntegrationEnvironment.isAvailable() })
struct RealDaemonTests {}
