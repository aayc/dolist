import DailyDoListMobileKit
import Foundation
import Testing
import UIKit

@testable import DailyDoList

@MainActor
struct PhoneProfileSelectionTests {
  @Test func failedWorkspaceConstructionDoesNotRerouteThePreviousProfilesDrafts() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let suite = "dolist-profile-selection-\(UUID())"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer {
      defaults.removePersistentDomain(forName: suite)
      try? FileManager.default.removeItem(at: root)
    }
    let origin = try ConnectionOrigin("https://notes.example.test")
    var original = ConnectionProfile(name: "Original host", origin: origin)
    original.workspaceID = "original-workspace"
    original.hostID = "original-host"
    var unavailable = ConnectionProfile(name: "Unavailable host", origin: origin)
    unavailable.workspaceID = "unavailable-workspace"
    unavailable.hostID = "unavailable-host"
    let scope = WorkspaceScope(
      profileID: original.id, workspaceID: "original-workspace", hostID: "original-host",
      origin: origin)
    let directory = root.appendingPathComponent("workspaces")
    let repository = try WorkspaceRepository(rootDirectory: directory, scope: scope)
    _ = try await repository.cache(
      RemoteNote(content: "Original text", version: "v1"), path: "Note.md")
    let workspace = try PhoneWorkspace(
      rootDirectory: directory,
      structural: WorkspaceStructuralCoordinator(rootDirectory: directory, scope: scope),
      recovery: WorkspaceRecovery(rootDirectory: directory, scope: scope), profile: original,
      repository: repository,
      drawingRepository: DrawingRepository(rootDirectory: directory, scope: scope),
      cache: WorkspaceCache(rootDirectory: directory, scope: scope),
      captureOutbox: CaptureOutbox(rootDirectory: directory, scope: scope))
    var constructions: [UUID] = []
    let model = PhoneAppModel(
      rootDirectory: root, defaults: defaults,
      credentials: KeychainConnectionCredentials(service: "app.dailydolist.iphone.tests.\(UUID())"),
      workspaceFactory: { profile in
        constructions.append(profile.id)
        if profile.id == unavailable.id { throw WorkspaceRepositoryError.corruptIndex }
        return workspace
      }, installIntegrations: false)
    // No socket, production Keychain item, notification center or production UserDefaults is used.
    await model.connection.setActive(false)
    try await model.prepareStorage()
    await model.select(original)
    #expect(model.workspace === workspace)
    let session = try #require(workspace.active)
    session.editor.input.insertText("Local draft ")
    let localText = session.editor.text

    await model.select(unavailable)

    #expect(model.workspace == nil)
    #expect(model.error != nil)
    #expect(model.connection.selected?.id == original.id)
    #expect(model.connection.client == nil)
    #expect(defaults.string(forKey: "selectedConnection") == original.id.uuidString)
    #expect(constructions == [original.id, unavailable.id])
    #expect(try await repository.note("Note.md")?.content == localText)
    await model.select(original)
    #expect(model.workspace === workspace)
    #expect(workspace.active?.editor.text == localText)
    #expect(constructions == [original.id, unavailable.id])
  }
}
