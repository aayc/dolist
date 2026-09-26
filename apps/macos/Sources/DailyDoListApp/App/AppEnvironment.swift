import AppKit
import DailyDoListAgent
import DailyDoListClient
import DailyDoListDaemon
import DailyDoListEditor
import DailyDoListModels
import DailyDoListUI
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
  /// Demo mode's daemon (`--demo`), made once per launch.
  var makeDemoDaemon: @MainActor () throws -> DemoDaemon = { try DemoDaemon.make() }
  /// Deletes a folder (the demo's, once its daemon stopped).
  var removeFolder: @MainActor (URL) -> Void = { try? FileManager.default.removeItem(at: $0) }
  /// Token + URL of an external daemon from DDL_HOME (throws when there's no token).
  var discoverEndpoint: @MainActor (_ home: URL, _ port: Int?) throws -> DaemonEndpoint
  var systemIntegration: SystemIntegrationBridge
  /// Wall clock ("today").
  var now: @Sendable () -> Date
  /// OS integrations with side effects: notifications, Dock badge, NSApp appearance, window
  /// observers, global hotkey. Off in tests.
  var enablesSystemServices: Bool
  /// The pasteboard behind vim's `+` and `*` registers (tests pass a private one).
  var vimPasteboard: @MainActor () -> NSPasteboard = { .general }
  /// Permission checks and prompts, System Settings, the guide panel and relaunching for computer
  /// use (tests pass fakes; the default touches nothing and reports access as granted).
  var computerAccess: ComputerAccessSystem = .inert
  /// Shows a file or folder in Finder.
  var revealInFinder: @MainActor (URL) -> Void = {
    NSWorkspace.shared.activateFileViewerSelecting([$0])
  }
  /// A folder picker (`NSOpenPanel`): the title and where it starts; nil when cancelled.
  var chooseFolder: @MainActor (_ title: String, _ start: String?) -> URL? = {
    FolderPicker.choose(title: $0, startingAt: $1)
  }
  /// Whether a folder exists on this Mac.
  var folderExists: @MainActor (String) -> Bool = { path in
    var isFolder: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &isFolder)
      && isFolder.boolValue
  }

  /// The real app. Demo mode keeps its own preferences so demo tabs never replace real ones.
  static func live() -> AppEnvironment {
    let options = LaunchOptions.current
    let defaults =
      options.demo ? UserDefaults(suiteName: "app.dailydolist.demo") ?? .standard : .standard
    return AppEnvironment(
      preferences: AppPreferences(defaults: defaults),
      launchOptions: options,
      scheduler: LiveScheduler.shared,
      supervisor: DaemonSupervisor(),
      makeClient: { HTTPDaemonClient(endpoint: $0) },
      discoverEndpoint: { home, port in try DaemonEndpoint.discover(home: home, port: port) },
      systemIntegration: SystemIntegrationFactory.make(),
      now: { Date() },
      enablesSystemServices: true,
      computerAccess: .live())
  }
}
