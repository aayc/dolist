import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// Read-only checks against a real local daemon (`pnpm dev` / `pnpm start`). Opt in with
/// `DDL_LIVE_DAEMON=1 apps/macos/scripts/test.sh DailyDoListClient`. Never writes to the vault.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["DDL_LIVE_DAEMON"] == "1"))
struct LiveDaemonSmokeTests {
  @Test func talksToTheLocalDaemon() async throws {
    let client = HTTPDaemonClient(endpoint: try DaemonEndpoint.discover())
    #expect(await client.waitUntilHealthy(timeout: .seconds(5)))
    let health = try await client.health()
    #expect(DaemonProtocol.isCompatible(apiVersion: health.apiVersion))
    _ = try await client.tree()
    _ = try await client.settings()
    _ = try await client.agentStatus()
    _ = try await client.approvals(status: .pending)
    _ = try await client.threads(notePath: nil, taskId: nil)
    _ = try await client.search("the", limit: 5)

    let recorder = StreamRecorder(client.events())
    await client.connect()
    try await recorder.waitFor("hello") { if case .event(.hello) = $0 { true } else { false } }
    #expect(client.connectionState.isConnected)
    await client.disconnect()
    try await recorder.waitForFinish()

    let wrongToken = HTTPDaemonClient(endpoint: DaemonEndpoint(baseURL: client.endpoint.baseURL, token: "not-the-token"))
    await #expect(throws: DaemonClientError.unauthorized) { try await wrongToken.tree() }
  }
}
