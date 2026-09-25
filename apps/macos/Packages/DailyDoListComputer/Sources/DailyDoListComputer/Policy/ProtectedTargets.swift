import Foundation

/// What the helper refuses to read or operate, with the error code `protected`. This is the one
/// list; `ProtectedTargetsTests` pins it, and `apps/macos/README.md` documents it.
///
/// Decisions come from the target process's real bundle id, its real names (localized, bundle and
/// file name) and the process tree (`TargetGuard`), and for windows from the page they show
/// (`WebUIGuard`), never from names the model supplies. It applies to every method that reads UI
/// content or acts: `snapshot`, `screenshot` with a pid, `press`, `setValue`, `typeText`, `key`,
/// `click`, `scroll`, `activate` and `resolveApp`.
public struct ProtectedTargets: Sendable {
  public enum Category: String, Sendable, CaseIterable {
    /// Daily Do List itself: its approval cards must stay the user's.
    case dailyDoList
    /// An app the helper runs under (the Daily Do List app, or the terminal or editor hosting the
    /// daemon), found by walking the helper's parent processes. Never listed in `rules`.
    case agentHost
    case systemSettings
    /// Authentication and login prompts.
    case securityPrompt
    /// Keychain Access, Passwords and password managers.
    case passwords
    case authenticator
    /// A window showing Daily Do List's web UI (a browser or anything with a web view).
    case webUI
  }

  public struct Rule: Sendable {
    public var category: Category
    /// Exact bundle ids, compared case-insensitively.
    public var bundleIdentifiers: [String]
    /// Bundle id prefixes, for helper processes and extensions (compared case-insensitively).
    public var bundleIdentifierPrefixes: [String]
    /// App names, compared by `normalizedName`: equal, or a prefix ("1Password" covers
    /// "1Password 7"). Used where bundle ids vary or are unknown.
    public var appNames: [String]
  }

  public var rules: [Rule]
  /// A page on one of these hosts and ports is Daily Do List's web UI.
  public var webUIHosts: Set<String>
  public var webUIPorts: Set<Int>
  /// A window whose title contains this (case-insensitively) shows Daily Do List.
  public var webUITitleMarker: String

  /// The standard list. `environment` adds the daemon's port when `DDL_PORT` sets one.
  public static func standard(environment: [String: String] = [:]) -> ProtectedTargets {
    var ports: Set<Int> = [5173, 7331]
    if let port = environment["DDL_PORT"].flatMap(Int.init), (1...65_535).contains(port) {
      ports.insert(port)
    }
    return ProtectedTargets(
      rules: [
        Rule(
          category: .dailyDoList, bundleIdentifiers: ["app.dailydolist.mac"],
          bundleIdentifierPrefixes: ["app.dailydolist."], appNames: ["Daily Do List"]),
        Rule(
          category: .systemSettings,
          bundleIdentifiers: ["com.apple.systempreferences", "com.apple.Settings"],
          bundleIdentifierPrefixes: [
            "com.apple.systempreferences.", "com.apple.settings.", "com.apple.preference.",
            "com.apple.preferences.",
          ],
          appNames: ["System Settings", "System Preferences"]),
        Rule(
          category: .securityPrompt,
          bundleIdentifiers: [
            "com.apple.SecurityAgent", "com.apple.loginwindow",
            "com.apple.LocalAuthentication.UIAgent",
          ],
          bundleIdentifierPrefixes: [], appNames: []),
        Rule(
          category: .passwords,
          bundleIdentifiers: [
            "com.apple.keychainaccess", "com.apple.Passwords", "com.1password.1password",
            "com.agilebits.onepassword7", "com.bitwarden.desktop", "org.keepassxc.keepassxc",
          ],
          bundleIdentifierPrefixes: [
            "com.apple.Passwords.", "com.1password.", "com.agilebits.", "com.bitwarden.",
            "com.dashlane.", "com.lastpass.", "org.keepassxc.",
          ],
          appNames: [
            "Keychain Access", "Passwords", "1Password", "Bitwarden", "Dashlane", "LastPass",
            "KeePassXC",
          ]),
        Rule(
          category: .authenticator, bundleIdentifiers: [],
          bundleIdentifierPrefixes: ["com.okta.", "com.yubico."],
          appNames: ["Okta Verify", "Yubico Authenticator"]),
      ],
      webUIHosts: ["127.0.0.1", "localhost", "::1", "0.0.0.0"],
      webUIPorts: ports,
      webUITitleMarker: "Daily Do List")
  }

  /// The category of an app, from its real bundle id and names; nil when it isn't protected.
  public func category(bundleIdentifier: String?, names: [String]) -> Category? {
    let bundle = bundleIdentifier?.lowercased()
    let normalized = names.map(Self.normalizedName).filter { !$0.isEmpty }
    for rule in rules {
      if let bundle {
        if rule.bundleIdentifiers.contains(where: { $0.lowercased() == bundle }) {
          return rule.category
        }
        if rule.bundleIdentifierPrefixes.contains(where: { bundle.hasPrefix($0.lowercased()) }) {
          return rule.category
        }
      }
      for protected in rule.appNames.map(Self.normalizedName)
      where normalized.contains(where: { $0.hasPrefix(protected) }) {
        return rule.category
      }
    }
    return nil
  }

  /// Whether a page's URL is Daily Do List's web UI (the daemon or the web dev server on this Mac).
  public func isWebUI(url: URL) -> Bool {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      var host = components.host?.lowercased(), let port = components.port
    else { return false }
    host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
    if host.hasSuffix(".") { host.removeLast() }
    return webUIHosts.contains(host) && webUIPorts.contains(port)
  }

  public func isWebUI(title: String) -> Bool {
    title.range(of: webUITitleMarker, options: [.caseInsensitive, .diacriticInsensitive]) != nil
  }

  /// Lowercased letters and digits only: "1Password 7" → "1password7".
  static func normalizedName(_ name: String) -> String {
    String(
      name.folding(
        options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil
      )
      .unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
  }

  /// The `protected` error for an app in `category`.
  static func error(for category: Category, appName: String) -> ComputerError {
    let message =
      switch category {
      case .dailyDoList:
        "Daily Do List is protected: the agent never operates Daily Do List itself."
      case .agentHost:
        "\(appName) runs the agent, so it's protected: the agent never operates the app it runs in."
      case .systemSettings:
        "\(appName) is protected: the agent never changes system settings or permissions."
      case .securityPrompt:
        "\(appName) is protected: the agent never touches login or authentication prompts."
      case .passwords:
        "\(appName) is protected: the agent never touches passwords or keychains."
      case .authenticator:
        "\(appName) is protected: the agent never touches authenticator apps."
      case .webUI:
        "\(appName) is showing Daily Do List, so it's protected: the agent never operates Daily "
          + "Do List itself."
      }
    return ComputerError(.protected, message)
  }
}
