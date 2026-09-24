import Foundation
import Observation

// Public API of the daemon supervisor. (Initial stub: attach-only — replaced by the full
// implementation that locates Node + the daemon bundle, spawns, health-checks and restarts it.)

/// How to reach (or launch) the daemon.
public struct DaemonLaunchConfiguration: Hashable, Sendable {
  /// DDL_HOME (token, config, workspaces). Default `~/.daily-do-list`.
  public var home: URL
  /// Vault folder (DDL_VAULT). Nil = the daemon's default (`~/DailyDoList`).
  public var vaultPath: URL?
  /// 127.0.0.1 port (DDL_PORT).
  public var port: Int
  /// `live`, `mock` or `off` (DDL_AGENT_MODE). Nil = daemon default.
  public var agentMode: String?
  /// Explicit Node binary; nil = search PATH and the usual install locations.
  public var nodePath: URL?
  /// Explicit daemon entry (`dist/main.js`); nil = bundled copy, then the repo checkout.
  public var daemonEntry: URL?
  /// Start the daemon if none is running (false = only attach to an existing one).
  public var manageProcess: Bool
  public var extraEnvironment: [String: String]

  public init(
    home: URL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".daily-do-list"),
    vaultPath: URL? = nil,
    port: Int = 7331,
    agentMode: String? = nil,
    nodePath: URL? = nil,
    daemonEntry: URL? = nil,
    manageProcess: Bool = true,
    extraEnvironment: [String: String] = [:]
  ) {
    self.home = home
    self.vaultPath = vaultPath
    self.port = port
    self.agentMode = agentMode
    self.nodePath = nodePath
    self.daemonEntry = daemonEntry
    self.manageProcess = manageProcess
    self.extraEnvironment = extraEnvironment
  }

  public var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }
  public var tokenFile: URL { home.appendingPathComponent("daemon-token") }
}

/// Base URL + bearer token of a reachable daemon.
public struct DaemonConnectionInfo: Hashable, Sendable {
  public var baseURL: URL
  public var token: String

  public init(baseURL: URL, token: String) {
    self.baseURL = baseURL
    self.token = token
  }
}

public enum DaemonSupervisorState: Equatable, Sendable {
  case idle
  case starting
  /// We launched it and it answers health checks.
  case running(pid: Int32, connection: DaemonConnectionInfo)
  /// It was already running (e.g. `pnpm dev`); we only connect.
  case attached(connection: DaemonConnectionInfo)
  /// Crashed; restarting after a backoff.
  case restarting(attempt: Int, reason: String)
  case failed(reason: String)
  case stopped

  public var connection: DaemonConnectionInfo? {
    switch self {
    case .running(_, let connection), .attached(let connection): connection
    default: nil
    }
  }
}

@MainActor
@Observable
public final class DaemonSupervisor {
  public private(set) var state: DaemonSupervisorState = .idle
  /// Recent daemon stdout/stderr lines (ring buffer), for Settings → Daemon → Logs.
  public private(set) var logLines: [String] = []
  public var configuration: DaemonLaunchConfiguration

  public init(configuration: DaemonLaunchConfiguration = DaemonLaunchConfiguration()) {
    self.configuration = configuration
  }

  /// Attaches to a running daemon, or launches one when `manageProcess` is set. Returns the
  /// connection once the daemon answers health checks.
  @discardableResult
  public func start() async -> DaemonConnectionInfo? {
    state = .starting
    guard let token = try? String(contentsOf: configuration.tokenFile, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty
    else {
      state = .failed(reason: "No daemon token at \(configuration.tokenFile.path)")
      return nil
    }
    let connection = DaemonConnectionInfo(baseURL: configuration.baseURL, token: token)
    state = .attached(connection: connection)
    return connection
  }

  /// Stops a daemon we launched (attached daemons keep running).
  public func stop() async {
    state = .stopped
  }

  public func restart() async {
    await stop()
    await start()
  }
}
