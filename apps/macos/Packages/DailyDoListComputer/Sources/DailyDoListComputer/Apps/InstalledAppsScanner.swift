import Foundation

/// Reads folders and app bundles, so the scan runs against fake folders in tests.
public protocol AppBundleReading: Sendable {
  /// Direct children, hidden files excluded.
  func contentsOfDirectory(_ url: URL) -> [URL]
  func isDirectory(_ url: URL) -> Bool
  /// The app at `url`, or nil when it isn't a readable app bundle with a bundle id.
  func app(at url: URL) -> InstalledApp?
}

/// `installedApps`: the apps in `/Applications`, `~/Applications` and `/System/Applications`, and
/// one folder level below them (`Utilities`, vendor folders, `Chrome Apps.localized`). Deduped by
/// bundle id (the first one found wins: roots in that order, direct children before nested ones)
/// and sorted by name.
enum InstalledAppsScanner {
  static func roots(home: URL) -> [URL] {
    [
      URL(fileURLWithPath: "/Applications", isDirectory: true),
      home.appendingPathComponent("Applications", isDirectory: true),
      URL(fileURLWithPath: "/System/Applications", isDirectory: true),
    ]
  }

  static func scan(roots: [URL], reader: any AppBundleReading) -> [InstalledApp] {
    var seen: Set<String> = []
    var apps: [InstalledApp] = []
    func consider(_ url: URL) {
      guard let app = reader.app(at: url), seen.insert(app.bundleId.lowercased()).inserted else {
        return
      }
      apps.append(app)
    }
    for root in roots {
      let entries = sorted(reader.contentsOfDirectory(root))
      for entry in entries where isApp(entry) { consider(entry) }
      for folder in entries where !isApp(folder) && reader.isDirectory(folder) {
        for entry in sorted(reader.contentsOfDirectory(folder)) where isApp(entry) {
          consider(entry)
        }
      }
    }
    return apps.sorted { lhs, rhs in
      switch lhs.name.localizedStandardCompare(rhs.name) {
      case .orderedAscending: true
      case .orderedDescending: false
      case .orderedSame: lhs.bundleId < rhs.bundleId
      }
    }
  }

  private static func isApp(_ url: URL) -> Bool { url.pathExtension.lowercased() == "app" }

  private static func sorted(_ urls: [URL]) -> [URL] {
    urls.sorted { $0.lastPathComponent < $1.lastPathComponent }
  }
}

/// The file system.
public struct FileAppBundleReader: AppBundleReading {
  public init() {}

  public func contentsOfDirectory(_ url: URL) -> [URL] {
    (try? FileManager.default.contentsOfDirectory(
      at: url, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])) ?? []
  }

  public func isDirectory(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
  }

  public func app(at url: URL) -> InstalledApp? {
    let plistURL = url.appendingPathComponent("Contents/Info.plist")
    guard let data = try? Data(contentsOf: plistURL),
      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil)
        as? [String: Any],
      let bundleId = plist["CFBundleIdentifier"] as? String, !bundleId.isEmpty
    else { return nil }
    let name = url.deletingPathExtension().lastPathComponent
    let displayName = (plist["CFBundleDisplayName"] as? String).flatMap { $0 == name ? nil : $0 }
    let bundleName = (plist["CFBundleName"] as? String).flatMap { $0 == name ? nil : $0 }
    return InstalledApp(
      name: name, bundleId: bundleId, url: url, displayName: displayName, bundleName: bundleName)
  }
}
