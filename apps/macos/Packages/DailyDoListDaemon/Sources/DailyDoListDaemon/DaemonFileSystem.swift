import Foundation

/// The few file-system questions the supervisor asks, injectable for tests.
public protocol DaemonFileSystem: Sendable {
  /// UTF-8 contents, or nil when the file is missing or unreadable.
  func readString(at url: URL) -> String?
  func fileExists(at url: URL) -> Bool
  func isExecutableFile(at url: URL) -> Bool
  /// Names of the entries in a directory (empty when it doesn't exist).
  func contentsOfDirectory(at url: URL) -> [String]
  /// Writes a small private (0600) file when its directory exists; best effort.
  func writeString(_ string: String, to url: URL)
  /// Changes whenever the file (after resolving symlinks) is replaced or modified; nil if missing.
  func fingerprint(of url: URL) -> String?
}

extension DaemonFileSystem {
  public func writeString(_ string: String, to url: URL) {}
  public func fingerprint(of url: URL) -> String? { nil }
}

/// The real file system.
public struct LocalDaemonFileSystem: DaemonFileSystem {
  public init() {}

  public func readString(at url: URL) -> String? {
    try? String(contentsOf: url, encoding: .utf8)
  }

  public func fileExists(at url: URL) -> Bool {
    var isDirectory: ObjCBool = false
    return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
      && !isDirectory.boolValue
  }

  public func isExecutableFile(at url: URL) -> Bool {
    fileExists(at: url) && FileManager.default.isExecutableFile(atPath: url.path)
  }

  public func contentsOfDirectory(at url: URL) -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
  }

  public func writeString(_ string: String, to url: URL) {
    let directory = url.deletingLastPathComponent().path
    guard FileManager.default.fileExists(atPath: directory) else { return }
    FileManager.default.createFile(
      atPath: url.path, contents: Data(string.utf8), attributes: [.posixPermissions: 0o600])
  }

  public func fingerprint(of url: URL) -> String? {
    let resolved = url.resolvingSymlinksInPath().path
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: resolved),
      let size = attributes[.size] as? NSNumber,
      let modified = attributes[.modificationDate] as? Date
    else { return nil }
    return "\(resolved)|\(size)|\(modified.timeIntervalSince1970)"
  }
}
