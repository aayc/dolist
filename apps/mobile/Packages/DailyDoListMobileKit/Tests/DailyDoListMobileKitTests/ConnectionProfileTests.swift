import Foundation
import Testing

@testable import DailyDoListMobileKit

struct ConnectionProfileTests {
  @Test func savedIdentitySurvivesRecreationAndMalformedFilesStayUntouched() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = FileConnectionProfileStore(directory: directory)
    var profile = ConnectionProfile(
      name: "Test phone", origin: try ConnectionOrigin("https://notes.example.test"))
    profile.workspaceID = "workspace-original"
    profile.hostID = "host-original"
    try await store.save(profile)
    let reopened = FileConnectionProfileStore(directory: directory)
    #expect(try await reopened.profiles() == [profile])
    var changed = profile
    changed.workspaceID = "workspace-replaced"
    await #expect(throws: FileConnectionProfileStore.StoreError.self) {
      try await reopened.save(changed)
    }
    #expect(try await reopened.profiles() == [profile])
    let file = directory.appendingPathComponent("connections.json")
    let damaged = Data("{damaged".utf8)
    try damaged.write(to: file)
    await #expect(throws: (any Error).self) { try await reopened.save(profile) }
    #expect(try Data(contentsOf: file) == damaged)
  }
}
