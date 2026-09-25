import DailyDoListDaemon
import DailyDoListModels
import Foundation
import Observation

/// How the app gets a daemon.
enum DaemonMode: String, CaseIterable, Identifiable, Sendable {
  /// The app starts and supervises its own daemon (or attaches to one already running).
  case managed
  /// Connect to a daemon started elsewhere (e.g. `pnpm dev`) at a configurable URL.
  case external

  var id: String { rawValue }

  var title: String {
    switch self {
    case .managed: "Managed by the app"
    case .external: "External"
    }
  }
}

/// Which sidebar panel is showing.
enum SidebarMode: String, Sendable {
  case files, search
}

/// App-level preferences persisted in `UserDefaults` (daemon connection, window layout, tabs).
/// Note/editor/agent settings live on the daemon (`AppSettings`), not here. Connection overrides
/// are layered on `DaemonLaunchConfiguration.standard()` (environment + `$DDL_HOME/config.json`),
/// so by default the app finds the same daemon a terminal `pnpm dev` would start.
@MainActor
@Observable
final class AppPreferences {
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let environment: [String: String]

  var daemonMode: DaemonMode {
    didSet { defaults.set(daemonMode.rawValue, forKey: Key.daemonMode) }
  }
  /// Base URL of an external daemon.
  var externalBaseURL: String {
    didSet { defaults.set(externalBaseURL, forKey: Key.externalBaseURL) }
  }
  /// Port of the managed daemon; nil = `$DDL_PORT` / config.json / 7331.
  var managedPortOverride: Int? {
    didSet { defaults.set(managedPortOverride, forKey: Key.managedPort) }
  }
  /// DDL_HOME override; nil = `$DDL_HOME` or `~/.daily-do-list`.
  var homeOverride: String? { didSet { defaults.set(homeOverride, forKey: Key.home) } }
  /// Vault folder override for the managed daemon; nil = `$DDL_VAULT` or the daemon's default.
  var vaultPath: String? { didSet { defaults.set(vaultPath, forKey: Key.vaultPath) } }
  /// DDL_AGENT_MODE for the managed daemon; nil = `$DDL_AGENT_MODE` or the daemon default.
  var agentMode: AgentMode? { didSet { defaults.set(agentMode?.rawValue, forKey: Key.agentMode) } }
  var launchAtLogin: Bool { didSet { defaults.set(launchAtLogin, forKey: Key.launchAtLogin) } }
  var globalHotkeyEnabled: Bool {
    didSet { defaults.set(globalHotkeyEnabled, forKey: Key.globalHotkeyEnabled) }
  }
  /// Display form, e.g. `⌃⌥⌘D`; nil = the system integration's default.
  var globalHotkey: String? { didSet { defaults.set(globalHotkey, forKey: Key.globalHotkey) } }

  var lastOpenTabs: [String] { didSet { defaults.set(lastOpenTabs, forKey: Key.lastOpenTabs) } }
  var lastActiveTab: String? { didSet { defaults.set(lastActiveTab, forKey: Key.lastActiveTab) } }
  var sidebarVisible: Bool { didSet { defaults.set(sidebarVisible, forKey: Key.sidebarVisible) } }
  var inspectorVisible: Bool {
    didSet { defaults.set(inspectorVisible, forKey: Key.inspectorVisible) }
  }
  var sidebarWidth: CGFloat {
    didSet { defaults.set(Double(sidebarWidth), forKey: Key.sidebarWidth) }
  }
  var inspectorWidth: CGFloat {
    didSet { defaults.set(Double(inspectorWidth), forKey: Key.inspectorWidth) }
  }
  var sidebarMode: SidebarMode {
    didSet { defaults.set(sidebarMode.rawValue, forKey: Key.sidebarMode) }
  }
  var expandedFolders: Set<String> {
    didSet { defaults.set(expandedFolders.sorted(), forKey: Key.expandedFolders) }
  }
  /// The main window's banner about computer use was dismissed (for good).
  var computerAccessBannerDismissed: Bool {
    didSet {
      defaults.set(computerAccessBannerDismissed, forKey: Key.computerAccessBannerDismissed)
    }
  }
  /// When Screen Recording was last requested: a launch soon after continues the setup.
  var computerAccessRequestedAt: Date? {
    didSet { defaults.set(computerAccessRequestedAt, forKey: Key.computerAccessRequestedAt) }
  }

  init(
    defaults: UserDefaults = .standard,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.defaults = defaults
    self.environment = environment
    daemonMode =
      defaults.string(forKey: Key.daemonMode).flatMap(DaemonMode.init(rawValue:)) ?? .managed
    externalBaseURL =
      defaults.string(forKey: Key.externalBaseURL)
      ?? "http://127.0.0.1:\(DaemonLaunchConfiguration.defaultPort)"
    let port = defaults.integer(forKey: Key.managedPort)
    managedPortOverride = (1...65_535).contains(port) ? port : nil
    homeOverride = defaults.string(forKey: Key.home)
    vaultPath = defaults.string(forKey: Key.vaultPath)
    agentMode = defaults.string(forKey: Key.agentMode).map(AgentMode.init(rawValue:))
    launchAtLogin = defaults.bool(forKey: Key.launchAtLogin)
    globalHotkeyEnabled = defaults.bool(forKey: Key.globalHotkeyEnabled)
    globalHotkey = defaults.string(forKey: Key.globalHotkey)
    lastOpenTabs = defaults.stringArray(forKey: Key.lastOpenTabs) ?? []
    lastActiveTab = defaults.string(forKey: Key.lastActiveTab)
    sidebarVisible = defaults.object(forKey: Key.sidebarVisible) as? Bool ?? true
    inspectorVisible = defaults.bool(forKey: Key.inspectorVisible)
    sidebarWidth =
      (defaults.object(forKey: Key.sidebarWidth) as? Double).map { CGFloat($0) }
      ?? PaneLayout.sidebarDefault
    inspectorWidth =
      (defaults.object(forKey: Key.inspectorWidth) as? Double).map { CGFloat($0) }
      ?? PaneLayout.inspectorDefault
    sidebarMode =
      defaults.string(forKey: Key.sidebarMode).flatMap(SidebarMode.init(rawValue:)) ?? .files
    expandedFolders = Set(defaults.stringArray(forKey: Key.expandedFolders) ?? ["Daily"])
    computerAccessBannerDismissed = defaults.bool(forKey: Key.computerAccessBannerDismissed)
    computerAccessRequestedAt = defaults.object(forKey: Key.computerAccessRequestedAt) as? Date
  }

  /// The supervisor configuration: the standard (terminal-equivalent) one plus overrides.
  var launchConfiguration: DaemonLaunchConfiguration {
    var configuration = DaemonLaunchConfiguration.standard(environment: environment)
    if let homeOverride = homeOverride?.trimmingCharacters(in: .whitespaces), !homeOverride.isEmpty
    {
      configuration.home = URL(fileURLWithPath: expandTilde(homeOverride), isDirectory: true)
    }
    if let vaultPath = vaultPath?.trimmingCharacters(in: .whitespaces), !vaultPath.isEmpty {
      configuration.vaultPath = URL(fileURLWithPath: expandTilde(vaultPath), isDirectory: true)
    }
    if let managedPortOverride { configuration.port = managedPortOverride }
    if let agentMode { configuration.agentMode = agentMode.rawValue }
    configuration.manageProcess = true
    return configuration
  }

  /// DDL_HOME in effect.
  var homeURL: URL { launchConfiguration.home }

  /// Parsed external base URL (http/https with a host), or nil when invalid.
  var externalURL: URL? {
    guard let url = URL(string: externalBaseURL.trimmingCharacters(in: .whitespaces)),
      let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https", url.host != nil
    else { return nil }
    return url
  }

  private func expandTilde(_ path: String) -> String {
    (path as NSString).expandingTildeInPath
  }

  private enum Key {
    static let daemonMode = "ddl.daemonMode"
    static let externalBaseURL = "ddl.externalBaseURL"
    static let managedPort = "ddl.managedPort"
    static let home = "ddl.home"
    static let vaultPath = "ddl.vaultPath"
    static let agentMode = "ddl.agentMode"
    static let launchAtLogin = "ddl.launchAtLogin"
    static let globalHotkeyEnabled = "ddl.globalHotkeyEnabled"
    static let globalHotkey = "ddl.globalHotkey"
    static let lastOpenTabs = "ddl.lastOpenTabs"
    static let lastActiveTab = "ddl.lastActiveTab"
    static let sidebarVisible = "ddl.sidebarVisible"
    static let inspectorVisible = "ddl.inspectorVisible"
    static let sidebarWidth = "ddl.sidebarWidth"
    static let inspectorWidth = "ddl.inspectorWidth"
    static let sidebarMode = "ddl.sidebarMode"
    static let expandedFolders = "ddl.expandedFolders"
    static let computerAccessBannerDismissed = "ddl.computerAccessBannerDismissed"
    static let computerAccessRequestedAt = "ddl.computerAccessRequestedAt"
  }
}
