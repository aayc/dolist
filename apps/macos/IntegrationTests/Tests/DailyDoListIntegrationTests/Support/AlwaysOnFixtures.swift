import DailyDoListClient
import DailyDoListDaemon
import DailyDoListModels
import Foundation
import Testing

/// A daemon of its own for one test (the always-on machine, a second device), stopped and deleted
/// after `body`, whatever happens.
@MainActor
func withDaemon<T>(
  environment: [String: String] = [:], _ body: (DaemonFixture) async throws -> T
) async throws -> T {
  let daemon = try await DaemonFixture.launch(environment: environment)
  do {
    let result = try await body(daemon)
    await daemon.shutdown()
    return result
  } catch {
    await daemon.shutdown()
    throw error
  }
}

/// The sync service (`apps/sync/dist/main.js`) on a free loopback port, with one vault in a
/// temporary database. Its token is a test secret: never printed.
@MainActor
final class SyncServiceFixture {
  let root: URL
  let port: Int
  let vault: String
  let token: String
  private let process: Process

  var url: String { "http://127.0.0.1:\(port)" }

  /// The environment that points a daemon at this service (it then shows sync read-only).
  var environment: [String: String] {
    ["DDL_SYNC_URL": url, "DDL_SYNC_VAULT": vault, "DDL_SYNC_TOKEN": token]
  }

  private init(root: URL, port: Int, vault: String, token: String, process: Process) {
    self.root = root
    self.port = port
    self.vault = vault
    self.token = token
    self.process = process
  }

  static func launch() async throws -> SyncServiceFixture {
    guard let node = await IntegrationEnvironment.node.value else {
      throw FixtureError("no Node.js 24.4+ for the sync service")
    }
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("ddl-sync-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let database = root.appendingPathComponent("sync.db").path
    let entry = IntegrationEnvironment.syncEntry.path

    struct Created: Decodable {
      let vault: String
      let token: String
    }
    let output = try await run(
      node, [entry, "vault", "create", "--name", "Integration", "--db", database, "--json"])
    let created = try JSONDecoder().decode(Created.self, from: output)

    let port = try LocalPort.findFree()
    let log = root.appendingPathComponent("sync.log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let process = Process()
    process.executableURL = node
    process.arguments = [entry, "serve", "--db", database, "--port", String(port)]
    let handle = try FileHandle(forWritingTo: log)
    process.standardOutput = handle
    process.standardError = handle
    try process.run()
    let service = SyncServiceFixture(
      root: root, port: port, vault: created.vault, token: created.token, process: process)
    let health = URL(string: "\(service.url)/v1/health")!
    let deadline = ContinuousClock.now + .seconds(20)
    while ContinuousClock.now < deadline {
      if let (_, response) = try? await URLSession.shared.data(from: health),
        (response as? HTTPURLResponse)?.statusCode == 200
      {
        return service
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    service.shutdown()
    throw FixtureError("the sync service didn't start")
  }

  func shutdown() {
    if process.isRunning {
      process.terminate()
      process.waitUntilExit()
    }
    try? FileManager.default.removeItem(at: root)
  }

  /// Runs a short command to completion and returns what it printed.
  private static func run(_ executable: URL, _ arguments: [String]) async throws -> Data {
    try await Task.detached {
      let process = Process()
      process.executableURL = executable
      process.arguments = arguments
      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = FileHandle.nullDevice
      try process.run()
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      guard process.terminationStatus == 0 else {
        throw FixtureError("\(arguments.dropFirst().prefix(2).joined(separator: " ")) failed")
      }
      return data
    }.value
  }
}

/// Polls `probe` until it returns a value (or `timeout` passes, failing with `what`).
@MainActor
func eventually<T>(
  _ what: String, timeout: Duration = .seconds(10), every interval: Duration = .milliseconds(250),
  _ probe: () async throws -> T?
) async throws -> T {
  let deadline = ContinuousClock.now + timeout
  while true {
    if let value = try await probe() { return value }
    if ContinuousClock.now >= deadline {
      throw FixtureError("Timed out after \(timeout) waiting for \(what)")
    }
    try await Task.sleep(for: interval)
  }
}

extension EventLog {
  /// The first `agent.status` at or after `from` whose placement matches.
  @MainActor
  func placement(
    from: Int = 0, timeout: Duration = .seconds(60), _ description: String,
    where match: @escaping (AgentPlacementStatus) -> Bool
  ) async throws -> AgentPlacementStatus {
    try await event(from: from, timeout: timeout, description) { event in
      guard case .agentStatus(let status) = event, let placement = status.placement,
        match(placement)
      else { return nil }
      return placement
    }
  }
}

/// Characters of core's pairing code alphabet (no 0, 1, I, L, O or U).
let pairingCodeAlphabet = Set("23456789ABCDEFGHJKMNPQRSTVWXYZ")
