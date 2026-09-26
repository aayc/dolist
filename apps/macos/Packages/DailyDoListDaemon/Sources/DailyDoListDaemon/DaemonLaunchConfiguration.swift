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
    home: URL = DaemonLaunchConfiguration.defaultHome,
    vaultPath: URL? = nil,
    port: Int = DaemonLaunchConfiguration.defaultPort,
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

  /// The daemon's default port (`DEFAULT_PORT` in `apps/daemon/src/config.ts`).
  public static let defaultPort = 7331

  /// `~/.daily-do-list`, the daemon's default DDL_HOME.
  public static var defaultHome: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(".daily-do-list", isDirectory: true)
  }

  public var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }
  public var tokenFile: URL { home.appendingPathComponent("daemon-token") }
  public var configFile: URL { home.appendingPathComponent("config.json") }

  /// The configuration a daemon started from a terminal would use, so the app attaches to a
  /// `pnpm dev` daemon and a managed daemon behaves the same: `DDL_HOME`, `DDL_VAULT`, `DDL_PORT`
  /// and `DDL_AGENT_MODE` from `environment`, then `port` from `$DDL_HOME/config.json`, then the
  /// defaults. (The vault and agent mode are only passed on when set here; otherwise the daemon
  /// reads them from its own config.)
  public static func standard(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
  ) -> DaemonLaunchConfiguration {
    var configuration = DaemonLaunchConfiguration()
    if let home = nonEmpty(environment["DDL_HOME"]) {
      configuration.home = expandingTilde(home, homeDirectory: homeDirectory)
    } else {
      configuration.home = homeDirectory.appendingPathComponent(".daily-do-list", isDirectory: true)
    }
    if let vault = nonEmpty(environment["DDL_VAULT"]) {
      configuration.vaultPath = expandingTilde(vault, homeDirectory: homeDirectory)
    }
    if let port = nonEmpty(environment["DDL_PORT"]).flatMap(Int.init), (1...65_535).contains(port) {
      configuration.port = port
    } else if let port = configuredPort(in: configuration.configFile) {
      configuration.port = port
    }
    if let mode = nonEmpty(environment["DDL_AGENT_MODE"]) {
      configuration.agentMode = mode.lowercased()
    }
    return configuration
  }

  /// `port` from the daemon's `config.json`; `0` ("pick a free port") can't be supervised.
  static func configuredPort(in configFile: URL) -> Int? {
    guard let data = try? Data(contentsOf: configFile),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let port = object["port"] as? Int, (1...65_535).contains(port)
    else { return nil }
    return port
  }
}

func nonEmpty(_ value: String?) -> String? {
  guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
  else { return nil }
  return trimmed
}

/// Expands a leading `~` (not `~user`) and standardizes the path.
func expandingTilde(_ path: String, homeDirectory: URL) -> URL {
  if path == "~" { return homeDirectory }
  if path.hasPrefix("~/") {
    return homeDirectory.appendingPathComponent(String(path.dropFirst(2))).standardizedFileURL
  }
  return URL(fileURLWithPath: path).standardizedFileURL
}
