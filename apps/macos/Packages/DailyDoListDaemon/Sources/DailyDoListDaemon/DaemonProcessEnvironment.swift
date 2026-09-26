import Foundation

/// Command line and environment of a managed daemon.
enum DaemonProcessEnvironment {
  /// Preloaded with `--import`: when stdin reaches EOF (the app is gone and the pipe it held
  /// closed), the daemon sends itself SIGTERM and shuts down gracefully.
  static let watchdogPreload =
    "data:text/javascript,process.stdin.on(\"end\",()=>process.kill(process.pid,\"SIGTERM\"));"
    + "process.stdin.on(\"error\",()=>{});process.stdin.resume();"

  static func arguments(entry: URL, stopsWhenAppExits: Bool) -> [String] {
    (stopsWhenAppExits ? ["--import", watchdogPreload] : []) + [entry.path]
  }

  /// The user's environment (without its `DDL_*` variables unless `inheritsDaemonSettings`), then
  /// the daemon settings of `configuration` (and `DDL_SUPERVISED`: the supervisor starts the daemon
  /// again when it exits to restart), a PATH that starts with Node's directory, and finally
  /// `configuration.extraEnvironment`.
  static func variables(
    base: [String: String], configuration: DaemonLaunchConfiguration, node: ResolvedNode
  ) -> [String: String] {
    var variables =
      configuration.inheritsDaemonSettings ? base : base.filter { !$0.key.hasPrefix("DDL_") }
    variables["DDL_HOME"] = configuration.home.path
    if let vault = configuration.vaultPath { variables["DDL_VAULT"] = vault.path }
    variables["DDL_PORT"] = String(configuration.port)
    if let mode = configuration.agentMode { variables["DDL_AGENT_MODE"] = mode }
    variables["DDL_SUPERVISED"] = "1"
    variables["PATH"] = searchPath(
      nodeDirectory: node.url.deletingLastPathComponent().path,
      loginShellPATH: node.loginShellPATH,
      inherited: base["PATH"])
    variables.merge(configuration.extraEnvironment) { _, extra in extra }
    return variables
  }

  /// Node's directory, then the login shell's PATH, then the inherited PATH (or the system
  /// default), without duplicates.
  static func searchPath(nodeDirectory: String, loginShellPATH: String?, inherited: String?)
    -> String
  {
    let fallback = "/usr/bin:/bin:/usr/sbin:/sbin"
    var seen = Set<String>()
    let parts = [nodeDirectory] + components(loginShellPATH) + components(inherited ?? fallback)
    return parts.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
  }

  private static func components(_ path: String?) -> [String] {
    path?.split(separator: ":").map(String.init) ?? []
  }
}
