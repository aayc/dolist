import DailyDoListClient
import DailyDoListDaemon
import DailyDoListModels
import Foundation
import Testing

extension RealDaemonTests {
  @MainActor
  @Suite("Supervisor restarts")
  struct Restarts {
    @Test func restartingTheDaemonMidStreamMakesClientsReconnectAndResync() async throws {
      let fixture = try Fixtures.current()
      let (client, log) = try await connectedClient(fixture)
      let before = try #require(fixture.supervisor.state.connection)
      guard case .running(let oldPid, _) = fixture.supervisor.state else {
        Issue.record("the fixture's daemon should be managed, got \(fixture.supervisor.state)")
        return
      }
      let mark = log.mark

      let after = try #require(await fixture.supervisor.restart(), "\(fixture.logTail)")

      guard case .running(let newPid, _) = fixture.supervisor.state else {
        Issue.record("expected a running daemon, got \(fixture.supervisor.state)")
        return
      }
      #expect(newPid != oldPid)
      #expect(after == before, "same port, same token file")
      let lostAt = try await log.index(from: mark, for: "reconnecting") { item in
        if case .state(.reconnecting) = item { return true }
        return false
      }
      let resyncAt = try await log.index(from: lostAt, for: "resync") { $0 == .resync }
      #expect(
        log.items[lostAt..<resyncAt].contains { item in
          if case .state(.connected) = item { return true }
          return false
        }, "reconnected before asking consumers to refetch")

      // The client is live again: REST works and writes are echoed on the new connection.
      #expect(try await client.health().ok)
      let path = "Restart/After \(unique()).md"
      let writeMark = log.mark
      _ = try await client.writeNote(path, content: "after the restart", baseVersion: .createOnly)
      let change = try await log.vaultChange(from: writeMark, path: path)
      #expect(change.clientId == client.clientId)
      await client.disconnect()
    }
  }
}
