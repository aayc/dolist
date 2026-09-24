import DailyDoListClient
import DailyDoListDaemon
import Foundation
import Testing

/// Where the integration tests find Node and the daemon, and why they would be skipped.
enum IntegrationEnvironment {
  /// The repository checkout containing this file (`DDL_REPO_ROOT` overrides it).
  static let repositoryRoot: URL = {
    if let root = ProcessInfo.processInfo.environment["DDL_REPO_ROOT"], !root.isEmpty {
      return URL(fileURLWithPath: root)
    }
    var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while directory.path != "/" {
      if FileManager.default.fileExists(atPath: directory.appendingPathComponent("apps/daemon/package.json").path) {
        return directory
      }
      directory.deleteLastPathComponent()
    }
    return directory
  }()
  static let daemonEntry = repositoryRoot.appendingPathComponent("apps/daemon/dist/main.js")

  static let node = Task<URL?, Never> {
    let locator = NodeLocator(
      configuredPath: nil, environment: ProcessInfo.processInfo.environment,
      homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
      fileSystem: LocalDaemonFileSystem(), commands: ProcessCommandRunner())
    return try? await locator.locate().url
  }

  static let skipReason: Comment = """
    Needs Node.js 24.4+ and the built daemon (apps/daemon/dist/main.js). \
    Run `pnpm install && pnpm --filter @ddl/daemon build` first.
    """

  static func isAvailable() async -> Bool {
    guard FileManager.default.fileExists(atPath: daemonEntry.path) else { return false }
    return await node.value != nil
  }
}

/// A real daemon (mock agent) in a temporary DDL_HOME and vault on a free port, started by
/// `DaemonSupervisor` once per suite.
@MainActor
final class DaemonFixture {
  let supervisor: DaemonSupervisor
  let root: URL
  var home: URL { root.appendingPathComponent("home") }
  var vault: URL { root.appendingPathComponent("vault") }

  private init(supervisor: DaemonSupervisor, root: URL) {
    self.supervisor = supervisor
    self.root = root
  }

  /// The current connection (the same across restarts: same port and token file).
  var connection: DaemonConnectionInfo {
    get throws {
      guard let connection = supervisor.state.connection else {
        throw FixtureError("the daemon is not ready: \(supervisor.state)\n\(logTail)")
      }
      return connection
    }
  }

  var logTail: String { supervisor.logLines.suffix(40).joined(separator: "\n") }

  static func launch() async throws -> DaemonFixture {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("ddl-integration-\(UUID().uuidString)", isDirectory: true)
    for folder in ["home", "vault"] {
      try FileManager.default.createDirectory(
        at: root.appendingPathComponent(folder), withIntermediateDirectories: true)
    }
    let configuration = DaemonLaunchConfiguration(
      home: root.appendingPathComponent("home"),
      vaultPath: root.appendingPathComponent("vault"),
      port: try LocalPort.findFree(),
      agentMode: "mock",
      nodePath: await IntegrationEnvironment.node.value,
      daemonEntry: IntegrationEnvironment.daemonEntry,
      manageProcess: true,
      extraEnvironment: ["DDL_LOG_LEVEL": "info"])
    let supervisor = DaemonSupervisor(
      configuration: configuration,
      dependencies: DaemonSupervisorDependencies(
        timing: DaemonSupervisorTiming(startupTimeout: .seconds(60))))
    let fixture = DaemonFixture(supervisor: supervisor, root: root)
    guard await supervisor.start() != nil else {
      let reason = "the daemon didn't start: \(supervisor.state)\n\(fixture.logTail)"
      await fixture.shutdown()
      throw FixtureError(reason)
    }
    return fixture
  }

  /// A new client with its own URL session and quick reconnects.
  func makeClient() throws -> HTTPDaemonClient {
    let connection = try connection
    return HTTPDaemonClient(
      endpoint: DaemonEndpoint(baseURL: connection.baseURL, token: connection.token),
      session: URLSession(configuration: .ephemeral),
      clientVersion: "macos-integration-tests",
      options: HTTPDaemonClient.Options(
        reconnectBackoff: ReconnectBackoff(
          initialDelay: .milliseconds(100), maximumDelay: .seconds(1), jitter: 0)))
  }

  func shutdown() async {
    await supervisor.stop()
    try? FileManager.default.removeItem(at: root)
  }
}

struct FixtureError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// The suite's daemon, set while a `.realDaemon` suite runs.
enum Fixtures {
  @TaskLocal static var daemon: DaemonFixture?

  static func current() throws -> DaemonFixture {
    guard let daemon else { throw FixtureError("no daemon: add the .realDaemon trait to the suite") }
    return daemon
  }
}

/// Launches one real daemon around a whole suite and stops it (and deletes its folders) after.
struct RealDaemonTrait: SuiteTrait, TestScoping {
  func provideScope(
    for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void
  ) async throws {
    let fixture = try await DaemonFixture.launch()
    do {
      try await Fixtures.$daemon.withValue(fixture) { try await function() }
    } catch {
      await fixture.shutdown()
      throw error
    }
    await fixture.shutdown()
  }
}

extension Trait where Self == RealDaemonTrait {
  /// Runs the suite against a real daemon launched by `DaemonSupervisor`.
  static var realDaemon: Self { Self() }
}
