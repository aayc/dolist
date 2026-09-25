import AppKit
import Foundation

/// `NSWorkspace`. Its app list only updates while the main run loop runs, so the helper keeps the
/// main thread running it (`HelperMain`) and reads `NSWorkspace` there.
public struct LiveWorkspace: WorkspaceAPI {
  private let reader: any AppBundleReading
  private let home: URL

  public init(
    reader: any AppBundleReading = FileAppBundleReader(),
    home: URL = FileManager.default.homeDirectoryForCurrentUser
  ) {
    self.reader = reader
    self.home = home
  }

  public func runningApplications() async -> [RunningApp] {
    await MainActor.run { NSWorkspace.shared.runningApplications.map(Self.describe) }
  }

  public func runningApplication(pid: Int32) async -> RunningApp? {
    await MainActor.run { NSRunningApplication(processIdentifier: pid).map(Self.describe) }
  }

  public func installedApplications() async -> [InstalledApp] {
    InstalledAppsScanner.scan(roots: InstalledAppsScanner.roots(home: home), reader: reader)
  }

  public func applicationURL(bundleIdentifier: String) async -> URL? {
    await MainActor.run {
      NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
    }
  }

  public func installedApplication(at url: URL) async -> InstalledApp? { reader.app(at: url) }

  public func openApplication(at url: URL) async throws -> Int32 {
    try await withCheckedThrowingContinuation { continuation in
      let configuration = NSWorkspace.OpenConfiguration()
      configuration.activates = false
      configuration.addsToRecentItems = false
      NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
        if let app {
          continuation.resume(returning: app.processIdentifier)
        } else {
          continuation.resume(
            throwing: error ?? ComputerError.failed("macOS didn't open \(url.lastPathComponent)."))
        }
      }
    }
  }

  /// Like clicking the app in the Dock: LaunchServices activates it (and a running app with no
  /// window may open one). `NSRunningApplication.activate` alone is often ignored when the
  /// caller isn't the active app, which the helper never is.
  public func activate(pid: Int32) async -> Bool {
    await MainActor.run {
      guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
      guard let url = app.bundleURL else { return app.activate(options: [.activateAllWindows]) }
      let configuration = NSWorkspace.OpenConfiguration()
      configuration.activates = true
      configuration.addsToRecentItems = false
      NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, _ in }
      return true
    }
  }

  @MainActor
  private static func describe(_ app: NSRunningApplication) -> RunningApp {
    let kind: RunningApp.Kind =
      switch app.activationPolicy {
      case .regular: .regular
      case .accessory: .accessory
      default: .background
      }
    let bundleName = app.bundleURL.flatMap {
      Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleName") as? String
    }
    return RunningApp(
      pid: app.processIdentifier, localizedName: app.localizedName,
      bundleId: app.bundleIdentifier, bundleName: bundleName, bundleURL: app.bundleURL,
      kind: kind, isActive: app.isActive, isHidden: app.isHidden,
      isFinishedLaunching: app.isFinishedLaunching)
  }
}
