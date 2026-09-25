import Foundation

/// A process as the protected-target check sees it: its real bundle id and names.
struct ProcessIdentity: Equatable, Sendable {
  var pid: Int32?
  var bundleId: String?
  /// Localized name, bundle name and file name (without `.app`), when known.
  var names: [String]

  var displayName: String { names.first ?? bundleId ?? pid.map { "Process \($0)" } ?? "This app" }
}

/// Applies `ProtectedTargets` to processes: the target's own bundle id and names, the apps the
/// helper runs under (its ancestors: the daemon and whatever hosts it), and the target's own
/// ancestors (a process started by a protected app is protected too).
struct TargetGuard: Sendable {
  let targets: ProtectedTargets
  /// The helper, its ancestors (launchd excluded) and theirs.
  let hostPIDs: Set<Int32>
  /// Lowercased bundle ids of the ancestors that are apps (another instance of the host counts).
  let hostBundleIDs: Set<String>
  /// Names of the host apps, for messages.
  let hostNames: [Int32: String]

  init(targets: ProtectedTargets, helper: Int32, hosts: [ProcessIdentity]) {
    self.targets = targets
    hostPIDs = Set(hosts.compactMap(\.pid)).union([helper])
    hostBundleIDs = Set(hosts.compactMap { $0.bundleId?.lowercased() })
    hostNames = Dictionary(
      hosts.compactMap { host in host.pid.map { ($0, host.displayName) } },
      uniquingKeysWith: { first, _ in first })
  }

  /// The `protected` error for `target`, or nil when it may be operated.
  func refusal(for target: ProcessIdentity, ancestors: [ProcessIdentity]) -> ComputerError? {
    if let reason = ownRefusal(for: target) { return reason }
    for ancestor in ancestors where ownRefusal(for: ancestor) != nil {
      return ComputerError(
        .protected,
        "\(target.displayName) was started by \(ancestor.displayName), which is protected, so it's "
          + "protected too.")
    }
    return nil
  }

  private func ownRefusal(for process: ProcessIdentity) -> ComputerError? {
    if let category = targets.category(bundleIdentifier: process.bundleId, names: process.names) {
      return ProtectedTargets.error(for: category, appName: process.displayName)
    }
    let isHost =
      process.pid.map(hostPIDs.contains) == true
      || process.bundleId.map { hostBundleIDs.contains($0.lowercased()) } == true
    guard isHost else { return nil }
    let name = process.pid.flatMap { hostNames[$0] } ?? process.displayName
    return ProtectedTargets.error(for: .agentHost, appName: name)
  }
}
