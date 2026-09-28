import DailyDoListMobileIntegration
import DailyDoListMobileKit
import Foundation
import Testing
import UIKit

@testable import DailyDoList

@MainActor
struct PhoneStorageProtectionTests {
  @Test func startupLoadsNothingUntilStoragePreparationSucceeds() async throws {
    let f = try await ProtectionFixture()
    defer { f.remove() }
    let unexpected = f.root.appendingPathComponent("unexpected-link")
    try FileManager.default.createSymbolicLink(
      at: unexpected, withDestinationURL: f.root.appendingPathComponent("workspaces"))
    let model = f.model()
    let protection = try #require(model.protection)

    await model.start()

    #expect(!protection.ready)
    #expect(protection.error == MobileStorageProtectionError.invalidPath.localizedDescription)
    #expect(model.connection.phase == .idle && model.connection.profiles.isEmpty)
    #expect(f.constructions == 0)
    try FileManager.default.removeItem(at: unexpected)
    await protection.retry()
    #expect(protection.ready)
    #expect(model.connection.profiles.map(\.id) == [f.profile.id])
    #expect(model.workspace?.active?.note.content == ProtectionFixture.saved)
  }

  @Test func unsavedLiveTextRefusesTheChangeAndKeepsTheWorkspace() async throws {
    let f = try await ProtectionFixture()
    defer { f.remove() }
    let model = f.model()
    let protection = try #require(model.protection)
    await model.start()
    let workspace = try #require(model.workspace)
    let session = try #require(workspace.active)
    let phase = model.connection.phase
    f.checkpoints?.rejectWrites = true
    session.editor.input.insertText("Unsaved synthetic typing ")
    let live = session.editor.text

    await protection.change(to: .whileUnlocked)

    #expect(protection.error != nil && protection.state.mode == .afterFirstUnlock)
    #expect(model.workspace === workspace && workspace.active === session)
    #expect(workspace.error != nil && model.connection.phase == phase)
    #expect(session.editor.text == live && session.hasUncheckpointedEdits)
    #expect(try await workspace.repository.note("Note.md")?.content == ProtectionFixture.saved)
  }

  @Test func aChangeSavesLiveWorkThenRecreatesTheWorkspaceAndReconnects() async throws {
    let f = try await ProtectionFixture()
    defer { f.remove() }
    let model = f.model()
    let protection = try #require(model.protection)
    await model.start()
    weak var previous = model.workspace
    let typed: String
    do {
      let workspace = try #require(model.workspace)
      workspace.selectedTab = 4
      let session = try #require(workspace.active)
      session.editor.input.insertText("Typed before the change ")
      typed = session.editor.text
    }

    await protection.change(to: .whileUnlocked)

    #expect(protection.ready && protection.error == nil)
    #expect(protection.state == PhoneProtectionState(mode: .whileUnlocked))
    #expect(previous == nil && f.constructions == 2)
    let recreated = try #require(model.workspace)
    #expect(recreated.active?.editor.text == typed && recreated.selectedTab == 4)
    #expect(model.connection.phase == .needsPairing)
  }

  @Test func aRetainedHandleLeavesARetryStateUntilItIsReleased() async throws {
    let f = try await ProtectionFixture()
    defer { f.remove() }
    let model = f.model()
    let protection = try #require(model.protection)
    await model.start()
    // Like a view that still holds the workspace after the model let it go.
    var retained = model.workspace

    await protection.change(to: .whileUnlocked)

    #expect(!protection.ready && !protection.busy)
    #expect(protection.error == MobileStorageProtectionError.busy.localizedDescription)
    #expect(protection.state.mode == .afterFirstUnlock)
    #expect(model.workspace == nil && model.connection.phase == .offline)
    #expect(try await retained?.repository.note("Note.md")?.content == ProtectionFixture.saved)
    retained = nil
    await protection.retry()
    #expect(protection.ready && protection.state.mode == .whileUnlocked)
    #expect(model.workspace?.active?.note.content == ProtectionFixture.saved)
    #expect(model.connection.phase == .needsPairing)
  }

  @Test func aColdIntentPreparesStorageBeforeReadingProfiles() async throws {
    let f = try await ProtectionFixture()
    defer { f.remove() }
    let model = f.model()
    model.notificationPreferences = PhoneNotificationPreferences(
      enabled: true, backgroundRefresh: true)
    let integrations = model.makeIntegrations(
      profiles: FileConnectionProfileStore(directory: f.root), credentials: f.credentials,
      rootDirectory: f.root, notificationCenter: SilentNotificationCenter())
    #expect(await !integrations.backgroundRefreshAllowed())

    let route = try await integrations.route(.today)

    #expect(route.scope == f.scope && model.protection?.ready == true)
    #expect(await integrations.backgroundRefreshAllowed())
  }
}

@MainActor
private final class ProtectionFixture {
  static let saved = "Saved synthetic text"
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let suite = "dolist-protection-\(UUID())"
  let defaults: UserDefaults
  let credentials = KeychainConnectionCredentials(
    service: "app.dailydolist.iphone.tests.\(UUID())")
  let profile: ConnectionProfile
  let scope: WorkspaceScope
  private(set) var checkpoints: RejectingCheckpoints?
  private(set) var constructions = 0
  private var workspaces: URL { root.appendingPathComponent("workspaces") }
  private var notes: URL { workspaces.appendingPathComponent("synthetic-notes") }

  init() async throws {
    defaults = try #require(UserDefaults(suiteName: suite))
    let origin = try ConnectionOrigin("https://notes.example.test")
    var profile = ConnectionProfile(name: "Synthetic host", origin: origin)
    profile.workspaceID = "synthetic-workspace"
    profile.hostID = "synthetic-host"
    self.profile = profile
    scope = WorkspaceScope(
      profileID: profile.id, workspaceID: "synthetic-workspace", hostID: "synthetic-host",
      origin: origin)
    // An earlier session's files, written before this model registers the storage root.
    try await FileConnectionProfileStore(directory: root).save(profile)
    _ = try await notesRepository(RejectingCheckpoints(notesCheckpoints())).cache(
      RemoteNote(content: Self.saved, version: "v1"), path: "Note.md")
    defaults.set(profile.id.uuidString, forKey: "selectedConnection")
  }

  func model() -> PhoneAppModel {
    let model = PhoneAppModel(
      rootDirectory: root, defaults: defaults, credentials: credentials,
      workspaceFactory: { [self] profile in
        constructions += 1
        let checkpoints = try RejectingCheckpoints(notesCheckpoints())
        self.checkpoints = checkpoints
        return try PhoneWorkspace(
          rootDirectory: workspaces,
          structural: WorkspaceStructuralCoordinator(rootDirectory: workspaces, scope: scope),
          recovery: WorkspaceRecovery(rootDirectory: workspaces, scope: scope), profile: profile,
          repository: notesRepository(checkpoints),
          drawingRepository: DrawingRepository(rootDirectory: workspaces, scope: scope),
          cache: WorkspaceCache(rootDirectory: workspaces, scope: scope),
          captureOutbox: CaptureOutbox(rootDirectory: workspaces, scope: scope))
      }, installIntegrations: false)
    model.storageDrainPause = { await Task.yield() }
    return model
  }

  func remove() {
    defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: root)
  }

  private func notesCheckpoints() throws -> MarkdownCheckpointStore {
    try MarkdownCheckpointStore(directory: notes.appendingPathComponent("markdown"))
  }

  private func notesRepository(_ checkpoints: RejectingCheckpoints) throws -> WorkspaceRepository {
    try WorkspaceRepository(
      scope: scope,
      index: SQLiteWorkspaceIndex(url: notes.appendingPathComponent("index.sqlite"), scope: scope),
      checkpoints: checkpoints)
  }
}

private struct SilentNotificationCenter: PhoneNotificationCenter {
  func requestAuthorization() async throws -> Bool { false }
  func authorized() async -> Bool { false }
  func existingIdentifiers() async -> Set<String> { [] }
  func deliver(_ notification: PhoneNotification) async throws {}
  func remove(_ identifiers: Set<String>) async {}
  func setBadge(_ count: Int) async throws {}
}
