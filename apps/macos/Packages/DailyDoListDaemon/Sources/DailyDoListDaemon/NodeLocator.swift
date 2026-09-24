import Foundation

/// A version as printed by `node --version`.
public struct NodeVersion: Comparable, Hashable, Sendable, CustomStringConvertible {
  public var major: Int
  public var minor: Int
  public var patch: Int

  /// The oldest Node the daemon supports (`engines.node` in the root `package.json`).
  public static let minimumSupported = NodeVersion(major: 24, minor: 4, patch: 0)

  public init(major: Int, minor: Int, patch: Int) {
    self.major = major
    self.minor = minor
    self.patch = patch
  }

  /// Parses the first line of `node --version` output: `v24.4.1`, `24.4.1`, `v25.0.0-nightly…`.
  /// Missing minor/patch components count as 0; anything else that isn't a version is nil.
  public init?(parsing text: String) {
    guard let firstLine = text.split(whereSeparator: \.isNewline).first else { return nil }
    var rest = Substring(firstLine.trimmingCharacters(in: .whitespaces))
    if rest.first == "v" || rest.first == "V" { rest = rest.dropFirst() }
    let core = rest.prefix { $0 == "." || ("0"..."9").contains($0) }
    guard !core.isEmpty, core.count == rest.count || "-+ ".contains(rest[core.endIndex]) else {
      return nil
    }
    let parts = core.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
    guard (1...3).contains(parts.count), parts.allSatisfy({ $0 != nil }) else { return nil }
    let numbers = parts.compactMap { $0 } + Array(repeating: 0, count: 3 - parts.count)
    self.init(major: numbers[0], minor: numbers[1], patch: numbers[2])
  }

  public var description: String { "v\(major).\(minor).\(patch)" }

  public static func < (lhs: NodeVersion, rhs: NodeVersion) -> Bool {
    (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
  }
}

/// A usable Node binary.
public struct ResolvedNode: Hashable, Sendable {
  public var url: URL
  public var version: NodeVersion
  public var source: NodeLocator.Source
  /// PATH of the user's login shell, when it was consulted (a Finder-launched app only has
  /// `/usr/bin:/bin:/usr/sbin:/sbin`; the daemon's connectors often need `npx`, `uvx`, …).
  public var loginShellPATH: String?

  public init(url: URL, version: NodeVersion, source: NodeLocator.Source, loginShellPATH: String? = nil) {
    self.url = url
    self.version = version
    self.source = source
    self.loginShellPATH = loginShellPATH
  }
}

/// Finds a Node binary that can run the daemon. Search order:
///
/// 1. `configuration.nodePath`, then `DDL_NODE` — explicit choices are used or rejected, never
///    silently replaced by another binary;
/// 2. every `node` on the user's login-shell PATH, in order (`/bin/zsh -lc 'whence -ap node'`,
///    the all-matches form of `command -v node`, with a timeout);
/// 3. every `node` on the PATH this process inherited (a terminal's, when not launched from
///    Finder);
/// 4. `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.local/share/mise/shims/node`,
///    `~/.volta/bin/node`;
/// 5. version managers that only configure interactive shells: nvm (newest installed version),
///    fnm's default alias, asdf's shim.
///
/// The first candidate whose `node --version` reports at least `minimumVersion` wins, so an old
/// Node early on the PATH doesn't hide a newer one.
public struct NodeLocator: Sendable {
  public enum Source: String, Hashable, Sendable {
    case configuration = "the app's configuration"
    case environment = "DDL_NODE"
    case loginShell = "the login shell's PATH"
    case inheritedPath = "the inherited PATH"
    case standardLocation = "a standard install location"
    case versionManager = "a Node version manager"
  }

  public var configuredPath: URL?
  public var environment: [String: String]
  public var homeDirectory: URL
  public var fileSystem: any DaemonFileSystem
  public var commands: any CommandRunning
  public var minimumVersion: NodeVersion
  /// Bounds the login-shell probe and each `node --version`.
  public var timeout: Duration
  public var loginShell: URL

  public init(
    configuredPath: URL?,
    environment: [String: String],
    homeDirectory: URL,
    fileSystem: any DaemonFileSystem,
    commands: any CommandRunning,
    minimumVersion: NodeVersion = .minimumSupported,
    timeout: Duration = .seconds(5),
    loginShell: URL = URL(fileURLWithPath: "/bin/zsh")
  ) {
    self.configuredPath = configuredPath
    self.environment = environment
    self.homeDirectory = homeDirectory
    self.fileSystem = fileSystem
    self.commands = commands
    self.minimumVersion = minimumVersion
    self.timeout = timeout
    self.loginShell = loginShell
  }

  /// Marker that separates the login shell's PATH from whatever its profile prints.
  static let pathMarker = "__DDL_LOGIN_PATH__="

  public func locate() async throws(DaemonSupervisorError) -> ResolvedNode {
    if let configuredPath {
      return try await verifyExplicit(configuredPath, source: .configuration)
    }
    if let fromEnvironment = nonEmpty(environment["DDL_NODE"]) {
      let url = expandingTilde(fromEnvironment, homeDirectory: homeDirectory)
      return try await verifyExplicit(url, source: .environment)
    }

    var searched = ["the login shell's PATH", "the inherited PATH"]
    var rejected: [String] = []
    var seen = Set<String>()
    let login = await probeLoginShell()
    let candidates: [(URL, Source)] =
      login.nodes.map { ($0, .loginShell) }
      + inheritedPathLocations.map { ($0, .inheritedPath) }
      + standardLocations.map { ($0, .standardLocation) }
      + versionManagerLocations.map { ($0, .versionManager) }
    for (url, source) in candidates {
      let path = url.standardizedFileURL.path
      guard seen.insert(path).inserted else { continue }
      if source == .standardLocation || source == .versionManager {
        searched.append(display(path))
      }
      guard fileSystem.isExecutableFile(at: url) else { continue }
      switch await probeVersion(url) {
      case .success(let version) where version >= minimumVersion:
        return ResolvedNode(url: url, version: version, source: source, loginShellPATH: login.path)
      case .success(let version):
        rejected.append("\(version) at \(display(path))")
      case .failure(let detail):
        rejected.append("\(display(path)) (\(detail))")
      }
    }
    if rejected.isEmpty { throw .nodeNotFound(searched: searched) }
    throw .nodeUnsupported(found: rejected)
  }

  var inheritedPathLocations: [URL] {
    (environment["PATH"] ?? "").split(separator: ":").map {
      URL(fileURLWithPath: String($0)).appendingPathComponent("node")
    }
  }

  var standardLocations: [URL] {
    [
      URL(fileURLWithPath: "/opt/homebrew/bin/node"),
      URL(fileURLWithPath: "/usr/local/bin/node"),
      homeDirectory.appendingPathComponent(".local/share/mise/shims/node"),
      homeDirectory.appendingPathComponent(".volta/bin/node"),
    ]
  }

  var versionManagerLocations: [URL] {
    let nvmVersions = homeDirectory.appendingPathComponent(".nvm/versions/node")
    let nvm =
      fileSystem.contentsOfDirectory(at: nvmVersions)
      .compactMap { name in NodeVersion(parsing: name).map { (name, $0) } }
      .sorted { $0.1 > $1.1 }
      .map { nvmVersions.appendingPathComponent($0.0).appendingPathComponent("bin/node") }
    return nvm + [
      homeDirectory.appendingPathComponent(".local/share/fnm/aliases/default/bin/node"),
      homeDirectory.appendingPathComponent("Library/Application Support/fnm/aliases/default/bin/node"),
      homeDirectory.appendingPathComponent(".asdf/shims/node"),
    ]
  }

  private func verifyExplicit(_ url: URL, source: Source) async throws(DaemonSupervisorError)
    -> ResolvedNode
  {
    let path = display(url.path)
    guard fileSystem.isExecutableFile(at: url) else {
      throw .configuredNodeUnusable(
        path: path, source: source.rawValue, detail: "it doesn't exist or isn't executable")
    }
    switch await probeVersion(url) {
    case .success(let version) where version >= minimumVersion:
      return ResolvedNode(url: url, version: version, source: source)
    case .success(let version):
      throw .configuredNodeUnusable(
        path: path, source: source.rawValue,
        detail: "it is \(version), but \(minimumVersion) or newer is required")
    case .failure(let detail):
      throw .configuredNodeUnusable(path: path, source: source.rawValue, detail: detail)
    }
  }

  private enum Probe {
    case success(NodeVersion)
    case failure(String)
  }

  private func probeVersion(_ url: URL) async -> Probe {
    let result = await commands.run(url, arguments: ["--version"], environment: nil, timeout: timeout)
    if result.timedOut { return .failure("`node --version` timed out") }
    guard result.succeeded else {
      let detail = nonEmpty(result.standardError).map { ": \($0.prefix(200))" } ?? ""
      return .failure("`node --version` failed with status \(result.status)\(detail)")
    }
    guard let version = NodeVersion(parsing: result.standardOutput) else {
      return .failure("unexpected `node --version` output \"\(result.standardOutput.prefix(80))\"")
    }
    return .success(version)
  }

  /// Runs the login shell once for every `node` on its PATH and the PATH itself.
  func probeLoginShell() async -> (nodes: [URL], path: String?) {
    let script = "whence -ap node; printf '\\n\(Self.pathMarker)%s\\n' \"$PATH\""
    let result = await commands.run(
      loginShell, arguments: ["-lc", script], environment: nil, timeout: timeout)
    guard !result.timedOut else { return ([], nil) }
    return Self.parseLoginShellOutput(result.standardOutput)
  }

  /// Profiles may print anything: node paths are the absolute paths before the PATH marker.
  static func parseLoginShellOutput(_ output: String) -> (nodes: [URL], path: String?) {
    var nodes: [URL] = []
    var path: String?
    for rawLine in output.split(whereSeparator: \.isNewline) {
      let line = rawLine.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix(pathMarker) {
        path = nonEmpty(String(line.dropFirst(pathMarker.count)))
      } else if path == nil, line.hasPrefix("/"), !line.contains(":") {
        nodes.append(URL(fileURLWithPath: line))
      }
    }
    return (nodes, path)
  }

  private func display(_ path: String) -> String {
    displayPath(path, homeDirectory: homeDirectory.path)
  }
}
