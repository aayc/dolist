import DailyDoListClient
import DailyDoListDaemon
import DailyDoListModels
import Foundation
import Testing

/// The Mac app's demo (`--demo`): the real daemon launched with `DaemonLaunchConfiguration.demo`
/// seeds a throwaway vault in its own folder and runs the mock agent there.
@MainActor
@Suite(
  "Demo daemon (real daemon)",
  .enabled(IntegrationEnvironment.skipReason) { await IntegrationEnvironment.isAvailable() })
struct DemoDaemonTests {
  @Test func seedsTheDemoVaultAndRunsTheMockAgentWithoutComputerUse() async throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("ddl-demo-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    var configuration = DaemonLaunchConfiguration.demo(root: root, port: try LocalPort.findFree())
    configuration.nodePath = await IntegrationEnvironment.node.value
    configuration.daemonEntry = IntegrationEnvironment.daemonEntry
    let supervisor = DaemonSupervisor(
      configuration: configuration,
      dependencies: DaemonSupervisorDependencies(
        timing: DaemonSupervisorTiming(startupTimeout: .seconds(60))))
    let started = await supervisor.start()
    let connection = try #require(
      started,
      "the demo daemon didn't start:\n\(supervisor.logLines.suffix(30).joined(separator: "\n"))")
    let client = HTTPDaemonClient(
      endpoint: DaemonEndpoint(baseURL: connection.baseURL, token: connection.token),
      session: URLSession(configuration: .ephemeral))
    do {
      let health = try await client.health()
      #expect(health.vaultName == "Demo Vault" && health.agentMode == .mock)
      let paths = Set(try await client.tree().entries.map(\.path))
      #expect(paths.isSuperset(of: ["Welcome.md", "Templates/Daily.md", "Sketches.md"]))
      #expect(try await client.dailyNote("today", create: false).created == false)
      let threads = try await client.threads(notePath: nil, taskId: nil)
      #expect(threads.contains { $0.id == "thr_demo_dinner" && $0.status == .done })
      #expect(try await client.agentStatus().execution.capabilities.computer == false)
    } catch {
      await supervisor.stop()
      throw error
    }
    await supervisor.stop()
  }
}
