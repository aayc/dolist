import DailyDoListClient
import Foundation

/// Provides the demo-mode client (`--demo` / `DDL_DEMO=1`): the in-memory daemon with the demo
/// vault, the simulated agent paced in real time, and a paired always-on machine to hand it to.
@MainActor
enum DemoClientFactory {
  static let make: (@MainActor () -> DaemonClient)? = {
    InMemoryDaemonClient(seed: .demo, clock: .realTime(), agent: .enabled, remote: .alwaysOn)
  }
}

/// Provides the OS integrations (launch at login, global hotkey).
@MainActor
enum SystemIntegrationFactory {
  static func make() -> SystemIntegrationBridge {
    SystemIntegration()
  }
}
