import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListMobileKit

@MainActor
struct ConnectionLifecycleTests {
  @Test func aChangedWorkspaceCannotReceiveTheOldProfilesClient() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let profiles = FileConnectionProfileStore(directory: root)
    var profile = ConnectionProfile(
      name: "Test phone", origin: try ConnectionOrigin("https://notes.example.test"))
    profile.workspaceID = "original"
    profile.hostID = "host"
    try await profiles.save(profile)
    let daemon = FakeDaemonClient()
    daemon.withState { state in
      state.health.workspaceId = "replacement"
      state.health.hostId = "host"
      state.health.capabilities = ["workspace-identity-v1"]
    }
    let connection = MobileConnection(profiles: profiles, credentials: AvailableCredential()) {
      _, _, _ in
      ConnectionChannel(client: daemon)
    }
    await connection.select(profile)
    #expect(connection.phase == .changedWorkspace)
    #expect(connection.client == nil)
    #expect(!connection.actionsEnabled)
    #expect(try await profiles.profiles() == [profile])
  }

  @Test func connectionRequiresLiveIdentityAndSuspensionRemovesActionAuthority() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let profiles = FileConnectionProfileStore(directory: root)
    let profile = ConnectionProfile(
      name: "Test phone", origin: try ConnectionOrigin("https://notes.example.test"))
    let daemon = FakeDaemonClient()
    daemon.withState { state in
      state.health.workspaceId = "workspace"
      state.health.hostId = "host"
      state.health.capabilities = ["workspace-identity-v1"]
    }
    let connection = MobileConnection(profiles: profiles, credentials: AvailableCredential()) {
      _, _, _ in
      ConnectionChannel(client: daemon)
    }
    let (verified, continuation) = AsyncStream<UUID>.makeStream()
    connection.onVerified = { profile, _ in continuation.yield(profile.id) }
    await connection.select(profile)
    var iterator = verified.makeAsyncIterator()
    #expect(await iterator.next() == profile.id)
    #expect(connection.actionsEnabled)
    #expect(connection.selected?.workspaceID == "workspace")
    await connection.setActive(false)
    #expect(!connection.actionsEnabled)
    #expect(connection.phase == .offline)
    #expect(connection.client == nil)
    #expect(daemon.withState { $0.connectionState } == .disconnected)
    #expect(try await profiles.profiles().first?.workspaceID == "workspace")
    continuation.finish()
  }

  @Test func scanningOnlyAcceptsAnHTTPSOriginAndOptionalPairingCode() throws {
    let plain = try PairingCodePayload("https://notes.example.test")
    #expect(plain.code == nil)
    let full = try PairingCodePayload(
      #"{"version":1,"url":"https://notes.example.test","code":"ABCD-2345"}"#)
    #expect(full.code == "ABCD2345")
    #expect(throws: (any Error).self) {
      try PairingCodePayload(
        #"{"version":1,"url":"https://other.example.test?token=secret","code":"ABCD2345"}"#)
    }
    #expect(throws: (any Error).self) { try PairingCodePayload("javascript:alert(1)") }
  }
}

private actor AvailableCredential: ConnectionCredentials {
  func token(for profile: UUID) -> String? { "synthetic-device-credential" }
  func save(_ token: String, for profile: UUID) {}
  func remove(_ profile: UUID) {}
}
