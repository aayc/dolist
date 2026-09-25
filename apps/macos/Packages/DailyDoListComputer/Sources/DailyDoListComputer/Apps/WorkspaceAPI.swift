import Foundation

/// A running app, as `NSWorkspace` reports it.
public struct RunningApp: Equatable, Sendable {
  public enum Kind: Sendable {
    /// In the Dock (`NSApplication.ActivationPolicy.regular`).
    case regular
    /// Menu bar extras and other UI without a Dock icon.
    case accessory
    /// No UI.
    case background
  }

  public var pid: Int32
  public var localizedName: String?
  public var bundleId: String?
  /// `CFBundleName` from the app's Info.plist.
  public var bundleName: String?
  public var bundleURL: URL?
  public var kind: Kind
  public var isActive: Bool
  public var isHidden: Bool
  public var isFinishedLaunching: Bool

  public init(
    pid: Int32, localizedName: String?, bundleId: String?, bundleName: String? = nil,
    bundleURL: URL? = nil, kind: Kind = .regular, isActive: Bool = false, isHidden: Bool = false,
    isFinishedLaunching: Bool = true
  ) {
    self.pid = pid
    self.localizedName = localizedName
    self.bundleId = bundleId
    self.bundleName = bundleName
    self.bundleURL = bundleURL
    self.kind = kind
    self.isActive = isActive
    self.isHidden = isHidden
    self.isFinishedLaunching = isFinishedLaunching
  }

  /// Localized name, bundle name and file name (without `.app`), without repeats.
  var names: [String] {
    uniqueNames([localizedName, bundleName, bundleURL?.deletingPathExtension().lastPathComponent])
  }

  var name: String { names.first ?? bundleId ?? "Process \(pid)" }

  var identity: ProcessIdentity { ProcessIdentity(pid: pid, bundleId: bundleId, names: names) }

  var summary: AppSummary { AppSummary(name: name, bundleId: bundleId, pid: pid) }
}

/// An app bundle on disk.
public struct InstalledApp: Equatable, Sendable {
  /// The file name without `.app`.
  public var name: String
  public var bundleId: String
  public var url: URL
  /// `CFBundleDisplayName` or the localized name, when it differs.
  public var displayName: String?
  /// `CFBundleName`.
  public var bundleName: String?

  public init(
    name: String, bundleId: String, url: URL, displayName: String? = nil, bundleName: String? = nil
  ) {
    self.name = name
    self.bundleId = bundleId
    self.url = url
    self.displayName = displayName
    self.bundleName = bundleName
  }

  var names: [String] { uniqueNames([displayName, bundleName, name]) }

  var identity: ProcessIdentity { ProcessIdentity(pid: nil, bundleId: bundleId, names: names) }
}

/// `NSWorkspace` and friends: which apps run, which are installed, launching and activating.
public protocol WorkspaceAPI: Sendable {
  func runningApplications() async -> [RunningApp]
  func runningApplication(pid: Int32) async -> RunningApp?
  func installedApplications() async -> [InstalledApp]
  func applicationURL(bundleIdentifier: String) async -> URL?
  func installedApplication(at url: URL) async -> InstalledApp?
  /// Launches the app without bringing it to the front; returns its pid once it runs.
  func openApplication(at url: URL) async throws -> Int32
  /// Asks to bring the app to the front; returns whether the request was made.
  func activate(pid: Int32) async -> Bool
}

private func uniqueNames(_ candidates: [String?]) -> [String] {
  var names: [String] = []
  for case let name? in candidates where !name.isEmpty && !names.contains(name) {
    names.append(name)
  }
  return names
}
