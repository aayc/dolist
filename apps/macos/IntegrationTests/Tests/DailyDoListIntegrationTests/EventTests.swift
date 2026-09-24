import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

extension RealDaemonTests {
  @MainActor
  @Suite("Events over WebSocket")
  struct Events {
    @Test func helloComesFirstWithTheAPIVersion() async throws {
      let fixture = try Fixtures.current()
      let client = try fixture.makeClient()
      let log = EventLog(client)

      await client.connect()
      let hello = try await log.event("hello") { event -> HelloEvent? in
        if case .hello(let hello) = event { return hello }
        return nil
      }

      #expect(hello.apiVersion == DaemonProtocol.apiVersion)
      #expect(hello.serverVersion == fixture.supervisor.health?.version)
      let states = log.items.compactMap { item -> ConnectionState? in
        if case .state(let state) = item { return state }
        return nil
      }
      #expect(states.first == .idle, "a stream starts with the current state")
      #expect(
        states.dropFirst().prefix(2) == [
          .connecting, .connected(serverVersion: hello.serverVersion),
        ])
      #expect(!log.items.contains(.resync), "a first connection needs no resync")
      await client.disconnect()
    }

    @Test func vaultChangesCarryTheWritersClientId() async throws {
      let fixture = try Fixtures.current()
      let (writer, writerLog) = try await connectedClient(fixture)
      let (observer, observerLog) = try await connectedClient(fixture)
      let path = "Events/Echo \(unique()).md"
      let (writerMark, observerMark) = (writerLog.mark, observerLog.mark)

      _ = try await writer.writeNote(path, content: "hello", baseVersion: .createOnly)

      let own = try await writerLog.vaultChange(from: writerMark, path: path)
      let seen = try await observerLog.vaultChange(from: observerMark, path: path)
      #expect(own.origin == .client)
      #expect(own.clientId == writer.clientId, "the writer can recognize (and ignore) its own echo")
      #expect(own.changes.first { $0.path == path }?.kind == .created)
      #expect(seen.clientId == writer.clientId)
      #expect(seen.clientId != observer.clientId)

      let reply = observerLog.mark
      _ = try await observer.writeNote(path, content: "hello back", baseVersion: .unconditional)
      let back = try await writerLog.vaultChange(from: writerMark + 1, path: path)
      let echo = try await observerLog.vaultChange(from: reply, path: path)
      #expect(echo.clientId == observer.clientId)
      #expect(back.changes.contains { $0.path == path })

      await writer.disconnect()
      await observer.disconnect()
    }

    @Test func externalEditsArriveWithoutAClientId() async throws {
      let fixture = try Fixtures.current()
      let (client, log) = try await connectedClient(fixture)
      let name = "External \(unique()).md"
      let folder = fixture.vault.appendingPathComponent("Events")
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let mark = log.mark

      try Data("written by another app".utf8).write(to: folder.appendingPathComponent(name))

      let change = try await log.vaultChange(from: mark, path: "Events/\(name)")
      #expect(change.origin == .external)
      #expect(change.clientId == nil)
      #expect(try await client.readNote("Events/\(name)").content == "written by another app")
      await client.disconnect()
    }

    @Test func settingsChangesAreBroadcast() async throws {
      let fixture = try Fixtures.current()
      let (client, log) = try await connectedClient(fixture)
      let before = try await client.settings()
      let theme: ThemePreference = before.theme == .dark ? .light : .dark
      let mark = log.mark

      _ = try await client.updateSettings(SettingsPatch(theme: theme))

      let broadcast = try await log.event(from: mark, "settings.changed") { event -> AppSettings? in
        if case .settingsChanged(let settings) = event { return settings }
        return nil
      }
      #expect(broadcast.theme == theme)
      _ = try await client.updateSettings(SettingsPatch(theme: before.theme))
      await client.disconnect()
    }
  }
}
