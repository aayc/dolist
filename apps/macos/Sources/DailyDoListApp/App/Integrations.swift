import DailyDoListDaemon
import Foundation

/// Demo mode (`--demo` / `DDL_DEMO=1`): the daemon with the mock agent on a throwaway demo vault,
/// in a new temporary folder each launch (deleted on quit) and on a free port, so it runs beside
/// the real app and never touches the real home or vault.
struct DemoDaemon: Equatable {
  var root: URL
  var configuration: DaemonLaunchConfiguration

  static func make() throws -> DemoDaemon {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("ddl-demo-\(UUID().uuidString)", isDirectory: true)
    return DemoDaemon(root: root, configuration: .demo(root: root, port: try LocalPort.findFree()))
  }
}

/// Provides the OS integrations (launch at login, global hotkey).
@MainActor
enum SystemIntegrationFactory {
  static func make() -> SystemIntegrationBridge {
    SystemIntegration()
  }
}
