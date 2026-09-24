import DailyDoListDaemon
import Foundation

/// The parts of ``DaemonSupervisor`` the app uses, so boot can be tested with a fake.
@MainActor
protocol DaemonSupervising: AnyObject {
  var state: DaemonSupervisorState { get }
  var logLines: [String] { get }
  var lastError: DaemonSupervisorError? { get }
  var configuration: DaemonLaunchConfiguration { get set }
  @discardableResult func start() async -> DaemonConnectionInfo?
  func stop() async
  @discardableResult func restart() async -> DaemonConnectionInfo?
  /// The current state, then every change.
  func stateUpdates() -> AsyncStream<DaemonSupervisorState>
  /// Synchronous SIGTERM of a managed daemon (last resort on quit).
  func terminateForAppExit()
  func clearLogs()
}

extension DaemonSupervisor: DaemonSupervising {}
