import Foundation
import Testing

@testable import DailyDoList
@testable import DailyDoListMobileKit

@MainActor
struct PhoneRetirementTests {
  @Test func interruptedRetirementResumesOnRestartAndRemovesTheProfileLast() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let suite = "dolist-retirement-\(UUID())"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer {
      defaults.removePersistentDomain(forName: suite)
      try? FileManager.default.removeItem(at: root)
    }
    var profile = ConnectionProfile(
      name: "Retired host", origin: try ConnectionOrigin("https://notes.example.test"))
    profile.workspaceID = "retired-workspace"
    profile.hostID = "retired-host"
    let profiles = FileConnectionProfileStore(directory: root)
    try await profiles.save(profile)
    defaults.set(profile.id.uuidString, forKey: "selectedConnection")
    let scope = WorkspaceScope(
      profileID: profile.id, workspaceID: "retired-workspace", hostID: "retired-host",
      origin: profile.origin)
    // Forget committed its durable retirement; an abandoned export for it is still staged.
    try await WorkspaceRecovery(
      rootDirectory: root.appendingPathComponent("workspaces"), scope: scope
    ).forget()
    let staging = root.appendingPathComponent("staging")
    _ = try await RecoveryExportStaging(rootDirectory: staging).begin(for: scope)

    let interrupted = PhoneAppModel(
      rootDirectory: root, defaults: defaults,
      exportStaging: RecoveryExportStaging(rootDirectory: staging) { _ in
        throw CocoaError(.fileWriteNoPermission)
      }, installIntegrations: false)
    await interrupted.connection.setActive(false)
    await interrupted.start()
    #expect(interrupted.error != nil)
    #expect(try await profiles.profiles().map(\.id) == [profile.id])

    let restarted = PhoneAppModel(
      rootDirectory: root, defaults: defaults,
      exportStaging: RecoveryExportStaging(rootDirectory: staging), installIntegrations: false)
    await restarted.connection.setActive(false)
    await restarted.start()
    #expect(restarted.error == nil)
    #expect(try await profiles.profiles().isEmpty)
    #expect(restarted.connection.profiles.isEmpty)
    #expect(defaults.string(forKey: "selectedConnection") == nil)
    #expect(try FileManager.default.contentsOfDirectory(atPath: staging.path) == ["staging.lock"])
  }
}
