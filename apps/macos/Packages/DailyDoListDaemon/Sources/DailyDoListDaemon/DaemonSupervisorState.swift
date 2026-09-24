import Foundation

/// Base URL + bearer token of a reachable daemon.
public struct DaemonConnectionInfo: Hashable, Sendable {
  public var baseURL: URL
  public var token: String

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }
}

/// What the daemon reported on its last successful `GET /api/health`.
public struct DaemonHealth: Codable, Hashable, Sendable {
  /// Daemon package version, e.g. `0.1.0`.
  public var version: String
  /// Major protocol version (the Swift client checks compatibility).
  public var apiVersion: Int
  public var vaultName: String?
  public var agentMode: String?

  public init(version: String, apiVersion: Int, vaultName: String? = nil, agentMode: String? = nil) {
    self.version = version
    self.apiVersion = apiVersion
    self.vaultName = vaultName
    self.agentMode = agentMode
  }
}

public enum DaemonSupervisorState: Equatable, Sendable {
  case idle
  case starting
  /// We launched it and it answers health checks.
  case running(pid: Int32, connection: DaemonConnectionInfo)
  /// It was already running (e.g. `pnpm dev`); we only connect.
  case attached(connection: DaemonConnectionInfo)
  /// Crashed (or an attached daemon went away); getting one back after a backoff. `attempt` counts
  /// the failures within the restart policy's window, starting at 1.
  case restarting(attempt: Int, reason: String)
  case failed(reason: String)
  case stopped

  public var connection: DaemonConnectionInfo? {
    switch self {
    case .running(_, let connection), .attached(let connection): connection
    default: nil
    }
  }

  /// A daemon answers health checks (managed or attached).
  public var isReady: Bool { connection != nil }

  /// Short human-readable description for status UI.
  public var summary: String {
    switch self {
    case .idle: "Not started"
    case .starting: "Starting…"
    case .running(let pid, _): "Running (pid \(pid))"
    case .attached: "Connected to a running daemon"
    case .restarting(let attempt, _): "Restarting (attempt \(attempt))…"
    case .failed: "Failed"
    case .stopped: "Stopped"
    }
  }
}
