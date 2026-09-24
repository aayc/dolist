import Foundation

/// Command-line / environment switches.
struct LaunchOptions: Equatable, Sendable {
  /// `--demo` or `DDL_DEMO=1`: run against the in-memory demo daemon (no Node, no network).
  var demo: Bool

  init(demo: Bool = false) {
    self.demo = demo
  }

  init(arguments: [String], environment: [String: String]) {
    let flag = environment["DDL_DEMO"]?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
    demo = arguments.contains("--demo") || ["1", "true", "yes", "on"].contains(flag)
  }

  static var current: LaunchOptions {
    LaunchOptions(
      arguments: CommandLine.arguments, environment: ProcessInfo.processInfo.environment)
  }
}
