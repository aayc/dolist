import Foundation

/// The local daemon's home folder (`DDL_HOME`: its token and `config.json`) and port, resolved the
/// way the daemon resolves them (`apps/daemon/src/config.ts` and `home-paths.ts`). The client and
/// the supervisor share it.
public enum DaemonHome {
  /// The daemon's default port (`DEFAULT_PORT`).
  public static let defaultPort = 7331

  /// `$DDL_HOME` (a leading `~` expanded), else `~/.daily-do-list`.
  public static func url(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> URL {
    nonEmpty(environment["DDL_HOME"]).map { expandingTilde($0, homeDirectory: homeDirectory) }
      ?? homeDirectory.appendingPathComponent(".daily-do-list", isDirectory: true)
  }

  /// The token the daemon writes at startup.
  public static func tokenFile(in home: URL) -> URL { home.appendingPathComponent("daemon-token") }

  /// A usable `$DDL_PORT`, else `port` from `<home>/config.json`, else nil. `0` ("pick a free
  /// port") counts as unset: nobody could find or supervise that daemon.
  public static func configuredPort(
    home: URL, environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Int? {
    if let port = nonEmpty(environment["DDL_PORT"]).flatMap(Int.init), (1...65_535).contains(port) {
      return port
    }
    guard let data = try? Data(contentsOf: home.appendingPathComponent("config.json")),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let port = object["port"] as? Int, (1...65_535).contains(port)
    else { return nil }
    return port
  }

  /// `~`-abbreviates a path under the home folder, so messages and logs don't spell out the user
  /// name.
  public static func displayPath(_ path: String, homeDirectory: String = NSHomeDirectory())
    -> String
  {
    if path == homeDirectory { return "~" }
    let prefix = homeDirectory.hasSuffix("/") ? homeDirectory : homeDirectory + "/"
    return path.hasPrefix(prefix) ? "~/" + path.dropFirst(prefix.count) : path
  }

  /// `value` without surrounding whitespace, or nil when that leaves nothing (the daemon's
  /// `nonEmpty`).
  public static func nonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
    else { return nil }
    return trimmed
  }

  /// Expands a leading `~` (not `~user`, like the daemon) and standardizes the path.
  public static func expandingTilde(_ path: String, homeDirectory: URL) -> URL {
    if path == "~" { return homeDirectory }
    if path.hasPrefix("~/") {
      return homeDirectory.appendingPathComponent(String(path.dropFirst(2))).standardizedFileURL
    }
    return URL(fileURLWithPath: path).standardizedFileURL
  }
}
