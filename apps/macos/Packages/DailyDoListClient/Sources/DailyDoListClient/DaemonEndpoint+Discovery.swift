import DailyDoListModels
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
      "No daemon token at \(DaemonHome.displayPath(path)). Start the daemon once to create it."
    case .tokenFileEmpty(let path):
      "The daemon token file \(DaemonHome.displayPath(path)) is empty."
    case .tokenFileUnreadable(let path, let reason):
      "Can't read the daemon token \(DaemonHome.displayPath(path)): \(reason)"
    case .invalidPort(let port): "\(port) is not a usable daemon port."
    }
  }
}

extension DaemonEndpoint {
  /// The endpoint of the local daemon: `http://127.0.0.1:<port>` and the token from
  /// `<home>/daemon-token` (trimmed).
  ///
  /// - Parameter port: When nil, resolved like the daemon does: `$DDL_PORT`, then `port` in
  ///   `<home>/config.json`, then 7331.
  public static func discover(home: URL, port: Int? = nil) throws(DaemonDiscoveryError)
    -> DaemonEndpoint
  {
    let tokenURL = DaemonHome.tokenFile(in: home)
    let data: Data
    do {
      data = try Data(contentsOf: tokenURL)
    } catch {
      if !FileManager.default.fileExists(atPath: tokenURL.path) {
        throw .tokenFileMissing(path: tokenURL.path)
      }
      throw .tokenFileUnreadable(path: tokenURL.path, reason: error.localizedDescription)
    }
    guard let token = DaemonHome.nonEmpty(String(decoding: data, as: UTF8.self)) else {
      throw .tokenFileEmpty(path: tokenURL.path)
    }
    let resolved = port ?? DaemonHome.configuredPort(home: home) ?? DaemonHome.defaultPort
    guard (1...65535).contains(resolved), let url = URL(string: "http://127.0.0.1:\(resolved)")
    else {
      throw .invalidPort(resolved)
    }
    return DaemonEndpoint(baseURL: url, token: token)
  }
}
