import Foundation

/// Where Node was found last time, so a launch can skip the login-shell probe and
/// `node --version` (~300 ms). An entry is only used while the binary is unchanged (same file,
/// size and modification date) and the overrides it was found with (configured path, `DDL_NODE`)
/// are the same; the supervisor refreshes it in the background after launching from it.
struct NodeLocationCache: Sendable {
  let file: URL
  let fileSystem: any DaemonFileSystem

  private struct Entry: Codable, Equatable {
    var key: String
    var path: String
    var version: String
    var source: String
    var loginShellPATH: String?
    var fingerprint: String
  }

  /// Identifies what the lookup depended on besides the file system.
  static func key(configuredPath: URL?, environment: [String: String]) -> String {
    "\(configuredPath?.path ?? "")\u{0}\(environment["DDL_NODE"] ?? "")"
  }

  func load(key: String) -> ResolvedNode? {
    guard let text = fileSystem.readString(at: file),
      let entry = try? JSONDecoder().decode(Entry.self, from: Data(text.utf8)),
      entry.key == key
    else { return nil }
    let url = URL(fileURLWithPath: entry.path)
    guard fileSystem.isExecutableFile(at: url),
      fileSystem.fingerprint(of: url) == entry.fingerprint,
      let version = NodeVersion(parsing: entry.version),
      let source = NodeLocator.Source(rawValue: entry.source)
    else { return nil }
    return ResolvedNode(
      url: url, version: version, source: source, loginShellPATH: entry.loginShellPATH)
  }

  /// Forgets the entry (a launch from it failed; version-manager shims can change what they run
  /// without the shim itself changing).
  func clear() {
    fileSystem.writeString("", to: file)
  }

  func save(_ node: ResolvedNode, key: String) {
    guard let fingerprint = fileSystem.fingerprint(of: node.url) else { return }
    let entry = Entry(
      key: key, path: node.url.path, version: node.version.description,
      source: node.source.rawValue,
      loginShellPATH: node.loginShellPATH, fingerprint: fingerprint)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(entry) else { return }
    fileSystem.writeString(String(decoding: data, as: UTF8.self), to: file)
  }
}
