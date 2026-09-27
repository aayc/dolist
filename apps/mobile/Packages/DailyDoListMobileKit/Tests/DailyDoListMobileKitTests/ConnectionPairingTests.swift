import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct ConnectionPairingTests {
  @Test func keychainFailureRetriesTheReceivedCredentialWithoutExchangingTheCodeAgain() async throws
  {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let profiles = FileConnectionProfileStore(directory: directory)
    let credentials = TestCredentials()
    let exchange = TestExchange()
    let service = PairingService(profiles: profiles, credentials: credentials) { origin, request in
      try await exchange.pair(origin, request)
    }
    let profile = ConnectionProfile(
      name: "Test phone", origin: try ConnectionOrigin("https://notes.example.test"))
    await #expect(throws: TestCredentials.Locked.self) {
      _ = try await service.pair(profile: profile, code: "abcd-2345")
    }
    #expect(try await profiles.profiles() == [profile])
    let paired = try await service.pair(profile: profile, code: "abcd-2345")
    #expect(paired.deviceID == "test-device")
    #expect(try await credentials.token(for: profile.id) == "test-credential")
    #expect(await exchange.requests.count == 1)
    #expect(await exchange.requests.first?.code == "ABCD2345")
    #expect(try await FileConnectionProfileStore(directory: directory).profiles() == [paired])
  }
}

private actor TestCredentials: ConnectionCredentials {
  struct Locked: Error {}
  private var locked = true
  private var tokens: [UUID: String] = [:]
  func token(for profile: UUID) throws -> String? { tokens[profile] }
  func save(_ token: String, for profile: UUID) throws {
    if locked {
      locked = false
      throw Locked()
    }
    tokens[profile] = token
  }
  func remove(_ profile: UUID) { tokens[profile] = nil }
}

private actor TestExchange {
  var requests: [PairRequest] = []
  func pair(_ origin: ConnectionOrigin, _ request: PairRequest) throws -> PairResponse {
    requests.append(request)
    return PairResponse(
      device: PairedDevice(
        id: "test-device", name: request.name, kind: .app, createdAt: 1, lastSeenAt: nil),
      token: "test-credential")
  }
}
