import DailyDoListModels
import Foundation

/// How to reach (or launch) the daemon.
public struct DaemonLaunchConfiguration: Hashable, Sendable {
  /// DDL_HOME (token, config, workspaces). Default `~/.daily-do-list`.
  public var home: URL
  /// Vault folder (DDL_VAULT). Nil = the daemon's default (`config.json`, then `~/DailyDoList`).
  public var vaultPath: URL?
  /// 127.0.0.1 port (DDL_PORT). Always passed to a managed daemon so the supervisor knows where
  /// it listens.
  public var port: Int
  /// `live`, `mock` or `off` (DDL_AGENT_MODE). Nil = daemon default.
  public var agentMode: String?
  /// Explicit Node binary; nil = `DDL_NODE`, the login shell's PATH, then the usual install
  /// locations (see `NodeLocator`).
  public var nodePath: URL?
  /// Explicit daemon entry (`dist/main.js`); nil = `DDL_DAEMON_ENTRY`, the copy bundled in the app,
  /// then a repository checkout (see `DaemonEntryLocator`).
  public var daemonEntry: URL?
  /// Start the daemon if none is running (false = only attach to an existing one).
  public var manageProcess: Bool
  /// Added to the managed daemon's environment last (wins over everything else).
  public var extraEnvironment: [String: String]
  /// Ties a managed daemon's lifetime to this process: if the app dies without calling `stop()`
  /// (crash, force quit), the daemon sees its stdin close and shuts itself down gracefully instead
  /// of lingering as an orphan that the next launch would attach to.
  public var stopsWhenAppExits: Bool
  /// Whether the `DDL_*` variables of this process's environment reach a managed daemon (a sync
  /// service, remote hosts, another vault). The demo's daemon gets none of them.
  public var inheritsDaemonSettings: Bool

  public init(
    home: URL = DaemonHome.url(environment: [:]),
    vaultPath: URL? = nil,
    port: Int = DaemonHome.defaultPort,
    agentMode: String? = nil,
    nodePath: URL? = nil,
    daemonEntry: URL? = nil,
    manageProcess: Bool = true,
    extraEnvironment: [String: String] = [:],
    stopsWhenAppExits: Bool = true,
    inheritsDaemonSettings: Bool = true
  ) {
    self.home = home
    self.vaultPath = vaultPath
    self.port = port
    self.agentMode = agentMode
    self.nodePath = nodePath
    self.daemonEntry = daemonEntry
    self.manageProcess = manageProcess
    self.extraEnvironment = extraEnvironment
    self.stopsWhenAppExits = stopsWhenAppExits
    self.inheritsDaemonSettings = inheritsDaemonSettings
  }

  /// The demo (`--demo`): a daemon of its own with the mock agent on `port`, its home and vault in
  /// `root`, a folder that doesn't exist yet. `DDL_DEMO=1` has the daemon seed the vault with the
  /// demo vault (and turn computer use off), and none of the user's `DDL_*` settings apply, so it
  /// never opens `~/.daily-do-list` or a real vault.
  public static func demo(root: URL, port: Int) -> DaemonLaunchConfiguration {
    DaemonLaunchConfiguration(
      home: root.appendingPathComponent("home", isDirectory: true),
      vaultPath: root.appendingPathComponent("Demo Vault", isDirectory: true),
      port: port, agentMode: "mock", extraEnvironment: ["DDL_DEMO": "1"],
      inheritsDaemonSettings: false)
  }

  public var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }
  public var tokenFile: URL { DaemonHome.tokenFile(in: home) }

  /// The configuration a daemon started from a terminal would use, so the app attaches to a
  /// `pnpm dev` daemon and a managed daemon behaves the same: `DDL_HOME`, `DDL_VAULT`, `DDL_PORT`
  /// and `DDL_AGENT_MODE` from `environment`, then `port` from `$DDL_HOME/config.json`, then the
  /// defaults. (The vault and agent mode are only passed on when set here; otherwise the daemon
  /// reads them from its own config.)
  public static func standard(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> DaemonLaunchConfiguration {
    var configuration = DaemonLaunchConfiguration(
      home: DaemonHome.url(environment: environment, homeDirectory: homeDirectory))
    if let vault = DaemonHome.nonEmpty(environment["DDL_VAULT"]) {
      configuration.vaultPath = DaemonHome.expandingTilde(vault, homeDirectory: homeDirectory)
    }
    configuration.port =
      DaemonHome.configuredPort(home: configuration.home, environment: environment)
      ?? DaemonHome.defaultPort
    if let mode = DaemonHome.nonEmpty(environment["DDL_AGENT_MODE"]) {
      configuration.agentMode = mode.lowercased()
    }
    return configuration
  }
}
