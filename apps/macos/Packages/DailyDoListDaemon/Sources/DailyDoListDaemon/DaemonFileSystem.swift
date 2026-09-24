import Foundation

/// The few file-system questions the supervisor asks, injectable for tests.
public protocol DaemonFileSystem: Sendable {
  /// UTF-8 contents, or nil when the file is missing or unreadable.
  func readString(at url: URL) -> String?
  func fileExists(at url: URL) -> Bool
  func isExecutableFile(at url: URL) -> Bool
  /// Names of the entries in a directory (empty when it doesn't exist).
  func contentsOfDirectory(at url: URL) -> [String]
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
}
