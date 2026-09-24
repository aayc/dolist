import Foundation

/// The daemon's `dist/main.js` and where it came from.
public struct ResolvedDaemonEntry: Hashable, Sendable {
  public var entry: URL
  public var source: DaemonEntryLocator.Source

  public init(entry: URL, source: DaemonEntryLocator.Source) {
    self.entry = entry
    self.source = source
  }

  /// The daemon package directory (`entry/../..`): the working directory of the process, so
  /// bare imports resolve from its `node_modules`.
  public var packageDirectory: URL {
    entry.deletingLastPathComponent().deletingLastPathComponent()
  }
}

/// Finds the daemon bundle to run. Search order:
///
/// 1. `configuration.daemonEntry`, then `DDL_DAEMON_ENTRY` (used or rejected, never replaced);
/// 2. the copy inside the app: `Contents/Resources/daemon/dist/main.js`
///    (`scripts/build-app.sh --with-daemon`);
/// 3. a repository checkout: `$DDL_REPO_ROOT/apps/daemon/dist/main.js`, then the first
///    `apps/daemon/dist/main.js` found walking up from the executable and from the current
///    directory (covers `swift run` and apps built into `apps/macos/build/`).
public struct DaemonEntryLocator: Sendable {
  public enum Source: String, Hashable, Sendable {
    case configuration = "the app's configuration"
    case environment = "DDL_DAEMON_ENTRY"
    case appBundle = "the app bundle"
    case repository = "the repository checkout"
  }

  /// Relative to a repository root.
  public static let repositoryEntryPath = "apps/daemon/dist/main.js"
  /// Relative to the app's `Contents/Resources`.
  public static let bundledEntryPath = "daemon/dist/main.js"

  public var configuredEntry: URL?
  public var environment: [String: String]
  public var bundleResourceURL: URL?
  public var executableURL: URL?
  public var currentDirectory: URL
  public var homeDirectory: URL
  public var fileSystem: any DaemonFileSystem

  public init(
    configuredEntry: URL?,
    environment: [String: String],
    bundleResourceURL: URL?,
    executableURL: URL?,
    currentDirectory: URL,
    homeDirectory: URL,
    fileSystem: any DaemonFileSystem
  ) {
    self.configuredEntry = configuredEntry
    self.environment = environment
    self.bundleResourceURL = bundleResourceURL
    self.executableURL = executableURL
    self.currentDirectory = currentDirectory
    self.homeDirectory = homeDirectory
    self.fileSystem = fileSystem
  }

  public func locate() throws(DaemonSupervisorError) -> ResolvedDaemonEntry {
    if let configuredEntry {
      return try explicit(configuredEntry, source: .configuration)
    }
    if let fromEnvironment = nonEmpty(environment["DDL_DAEMON_ENTRY"]) {
      return try explicit(
        expandingTilde(fromEnvironment, homeDirectory: homeDirectory), source: .environment)
    }
    var searched: [String] = []
    for (entry, source) in candidates() {
      let path = entry.standardizedFileURL.path
      if !searched.contains(display(path)) { searched.append(display(path)) }
      if fileSystem.fileExists(at: entry) {
        return ResolvedDaemonEntry(entry: entry.standardizedFileURL, source: source)
      }
    }
    if executableURL != nil { searched.append("parents of the app's executable") }
    searched.append("parents of the current directory")
    throw .daemonEntryNotFound(searched: searched)
  }

  /// Candidates in order; walks stop at the first directory containing the repository entry.
  func candidates() -> [(URL, Source)] {
    var result: [(URL, Source)] = []
    if let bundleResourceURL {
      result.append((bundleResourceURL.appendingPathComponent(Self.bundledEntryPath), .appBundle))
    }
    if let root = nonEmpty(environment["DDL_REPO_ROOT"]) {
      let url = expandingTilde(root, homeDirectory: homeDirectory)
      result.append((url.appendingPathComponent(Self.repositoryEntryPath), .repository))
    }
    var starts: [URL] = []
    if let executableURL {
      starts.append(executableURL.resolvingSymlinksInPath().deletingLastPathComponent())
    }
    starts.append(currentDirectory)
    for start in starts {
      if let found = findUpwards(from: start) { result.append((found, .repository)) }
    }
    return result
  }

  private func findUpwards(from start: URL) -> URL? {
    var directory = start.standardizedFileURL
    for _ in 0..<64 {
      let entry = directory.appendingPathComponent(Self.repositoryEntryPath)
      if fileSystem.fileExists(at: entry) { return entry }
      if directory.path == "/" || directory.path.isEmpty { return nil }
      directory = directory.deletingLastPathComponent().standardizedFileURL
    }
    return nil
  }

  private func explicit(_ entry: URL, source: Source) throws(DaemonSupervisorError)
    -> ResolvedDaemonEntry
  {
    guard fileSystem.fileExists(at: entry) else {
      throw .configuredEntryMissing(path: display(entry.path), source: source.rawValue)
    }
    return ResolvedDaemonEntry(entry: entry.standardizedFileURL, source: source)
  }

  private func display(_ path: String) -> String {
    displayPath(path, homeDirectory: homeDirectory.path)
  }
}
