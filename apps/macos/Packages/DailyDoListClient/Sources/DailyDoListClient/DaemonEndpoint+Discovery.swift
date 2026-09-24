import Foundation

/// Why `DaemonEndpoint.discover` could not produce an endpoint.
public enum DaemonDiscoveryError: Error, Equatable, Sendable {
  /// No token file: the daemon has never run with this home directory.
  case tokenFileMissing(path: String)
  /// The token file is empty (or only whitespace).
  case tokenFileEmpty(path: String)
  case tokenFileUnreadable(path: String, reason: String)
  case invalidPort(Int)
}

extension DaemonDiscoveryError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .tokenFileMissing(let path):
      "No daemon token at \(DaemonEndpoint.displayPath(path)). Start the daemon once to create it."
    case .tokenFileEmpty(let path):
      "The daemon token file \(DaemonEndpoint.displayPath(path)) is empty."
    case .tokenFileUnreadable(let path, let reason):
      "Can't read the daemon token \(DaemonEndpoint.displayPath(path)): \(reason)"
    case .invalidPort(let port): "\(port) is not a usable daemon port."
    }
  }
}

extension DaemonEndpoint {
  public static let defaultPort = 7331
  public static let tokenFileName = "daemon-token"

  /// `$DDL_HOME` when set (like the daemon), else `~/.daily-do-list`.
  public static var defaultHome: URL {
    let home = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
    if let raw = ProcessInfo.processInfo.environment["DDL_HOME"]?.trimmingCharacters(
      in: .whitespaces),
      !raw.isEmpty
    {
      if raw == "~" { return home }
      if raw.hasPrefix("~/") {
        return home.appendingPathComponent(String(raw.dropFirst(2)), isDirectory: true)
      }
      return URL(fileURLWithPath: raw, isDirectory: true)
    }
    return home.appendingPathComponent(".daily-do-list", isDirectory: true)
  }

  /// The endpoint of the local daemon: `http://127.0.0.1:<port>` and the token from
  /// `<home>/daemon-token` (trimmed).
  ///
  /// - Parameter port: When nil, resolved like the daemon does: `$DDL_PORT`, then `port` in
  ///   `<home>/config.json`, then 7331.
  public static func discover(
    home: URL = DaemonEndpoint.defaultHome, port: Int? = nil
  ) throws(DaemonDiscoveryError) -> DaemonEndpoint {
    let tokenURL = home.appendingPathComponent(tokenFileName)
    let data: Data
    do {
      data = try Data(contentsOf: tokenURL)
    } catch {
      if !FileManager.default.fileExists(atPath: tokenURL.path) {
        throw .tokenFileMissing(path: tokenURL.path)
      }
      throw .tokenFileUnreadable(path: tokenURL.path, reason: error.localizedDescription)
    }
    let token = String(decoding: data, as: UTF8.self).trimmingCharacters(
      in: .whitespacesAndNewlines)
    guard !token.isEmpty else { throw .tokenFileEmpty(path: tokenURL.path) }
    let resolved = port ?? configuredPort(home: home) ?? defaultPort
    guard (1...65535).contains(resolved), let url = URL(string: "http://127.0.0.1:\(resolved)")
    else {
      throw .invalidPort(resolved)
    }
    return DaemonEndpoint(baseURL: url, token: token)
  }

  /// `$DDL_PORT`, else `port` from `<home>/config.json` (0 = "pick a free port" is ignored).
  static func configuredPort(
    home: URL, environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> Int? {
    if let raw = environment["DDL_PORT"]?.trimmingCharacters(in: .whitespaces), !raw.isEmpty {
      return Int(raw)
    }
    guard let data = try? Data(contentsOf: home.appendingPathComponent("config.json")),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let port = object["port"] as? Int, port > 0
    else { return nil }
    return port
  }

  /// `~`-abbreviated path for messages, so they don't spell out the user name.
  static func displayPath(_ path: String) -> String {
    let home = NSHomeDirectory()
    if path == home { return "~" }
    return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
  }
}
