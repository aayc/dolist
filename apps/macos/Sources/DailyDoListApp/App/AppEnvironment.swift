import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListDaemon
import DailyDoListEditor
import DailyDoListModels
import Foundation

/// Everything ``AppModel`` depends on, injectable for tests (fake supervisor/client, manual time,
/// isolated `UserDefaults`, no OS side effects).
@MainActor
struct AppEnvironment {
  var preferences: AppPreferences
  var launchOptions: LaunchOptions
  var scheduler: AppScheduler
  var supervisor: DaemonSupervising
  var makeClient: @MainActor (DaemonEndpoint) -> DaemonClient
  /// The in-memory demo daemon (`--demo`); nil when this build can't provide one.
  var makeDemoClient: (@MainActor () -> DaemonClient)?
  /// Token + URL of an external daemon from DDL_HOME (throws when there's no token).
  var discoverEndpoint: @MainActor (_ home: URL, _ port: Int?) throws -> DaemonEndpoint
  var systemIntegration: SystemIntegrationBridge
  /// Wall clock ("today").
  var now: @Sendable () -> Date
  /// OS integrations with side effects: notifications, Dock badge, NSApp appearance, window
  /// observers, global hotkey. Off in tests.
  var enablesSystemServices: Bool
  /// The pasteboard behind vim's `+` and `*` registers (tests pass a private one).
  var vimPasteboard: @MainActor () -> VimPasteboard = { SystemVimPasteboard() }

  /// The real app. Demo mode keeps its own preferences so demo tabs never replace real ones.
  static func live() -> AppEnvironment {
    let options = LaunchOptions.current
    let defaults = options.demo ? UserDefaults(suiteName: "app.dailydolist.demo") ?? .standard : .standard
    return AppEnvironment(
      preferences: AppPreferences(defaults: defaults),
      launchOptions: options,
      scheduler: LiveScheduler.shared,
      supervisor: DaemonSupervisor(),
      makeClient: { HTTPDaemonClient(endpoint: $0) },
      makeDemoClient: DemoClientFactory.make,
      discoverEndpoint: { home, port in try DaemonEndpoint.discover(home: home, port: port) },
      systemIntegration: SystemIntegrationFactory.make(),
      now: { Date() },
      enablesSystemServices: true)
  }
}
