import DailyDoListDrawingModel
import DailyDoListMobileKit
import Foundation
import Testing
import UIKit

@testable import DailyDoList

@MainActor
struct DestructiveCheckpointTests {
  @Test func reviewedHostTextCannotReplaceTypingWhoseCheckpointFailed() async throws {
    let fixture = try DestructiveCheckpointFixture()
    defer { fixture.remove() }
    let original = try await fixture.workspace.repository.cache(
      RemoteNote(content: "Host text", version: "v1"), path: "Note.md")
    let parked = try await fixture.workspace.repository.saveForReview(
      path: original.path, content: "Reviewed local text", expectedRevision: original.localRevision)
    let session = NoteSession(note: parked, repository: fixture.workspace.repository)
    fixture.workspace.sessions[parked.path] = session
    let review = try #require(try await fixture.workspace.repository.review(parked.path))
    fixture.checkpoints.rejectWrites = true
    session.editor.selection = NSRange(location: session.editor.text.utf16.count, length: 0)
    session.editor.input.insertText(" and newer typing")
    let liveText = session.editor.text

    await #expect(throws: PhoneRecoveryPreparationError.unsavedNote(parked.path)) {
      _ = try await fixture.workspace.resolveNoteReview(review, as: .host)
    }
    #expect(session.editor.text == liveText)
    #expect(session.hasUncheckpointedEdits)
    #expect(session.editor.configuration.isEditable)
    #expect(try await fixture.workspace.repository.note(parked.path)?.content == parked.content)
    #expect(try await fixture.workspace.repository.note(parked.path)?.state == .needsReview)
  }

  @Test func hiddenEditorsAreReleasedOnlyOnceTheirTypingIsSaved() async throws {
    let fixture = try DestructiveCheckpointFixture()
    defer { fixture.remove() }
    let workspace = fixture.workspace
    for path in ["A.md", "B.md", "C.md"] {
      _ = try await workspace.repository.cache(RemoteNote(content: path, version: "v1"), path: path)
    }
    await workspace.open("A.md")
    await workspace.open("B.md")
    #expect(Set(workspace.sessions.keys) == ["B.md"])
    let typing = try #require(workspace.sessions["B.md"])
    typing.editor.selection = NSRange(location: 0, length: 0)
    typing.editor.input.insertText("Unsaved ")
    fixture.checkpoints.rejectWrites = true
    await workspace.open("C.md")
    #expect(Set(workspace.sessions.keys) == ["B.md", "C.md"])
    #expect(workspace.sessions["B.md"]?.editor.text == "Unsaved B.md")
    fixture.checkpoints.rejectWrites = false
    await workspace.open("A.md")
    #expect(Set(workspace.sessions.keys) == ["A.md"])
    #expect(try await workspace.repository.note("B.md")?.content == "Unsaved B.md")
  }

  @Test func reviewedHostDrawingCannotReplaceSceneWhoseCheckpointFailed() async throws {
    let fixture = try DestructiveCheckpointFixture()
    defer { fixture.remove() }
    let path = "Sketch.excalidraw.md"
    _ = try await fixture.workspace.drawingRepository.cache(
      RemoteNote(
        content: ExcalidrawMarkdown.serialize(ExcalidrawScene(), previous: nil), version: "v1"),
      path: path)
    var record = try #require(try fixture.index.document(path))
    record.state = .needsReview
    try fixture.index.commit(
      path: path, document: record, pending: nil, expectedGeneration: record.generation)
    let review = try #require(try await fixture.workspace.drawingRepository.review(path))
    let session = DrawingSession(
      drawing: review.drawing, repository: fixture.workspace.drawingRepository)
    fixture.workspace.drawingSessions[path] = session
    fixture.checkpoints.rejectWrites = true
    session.controller.editor.tool = .rectangle
    session.controller.editor.pointerDown(at: .init(10, 10))
    session.controller.editor.pointerDragged(to: .init(60, 50))
    session.controller.finishEditing()
    let liveScene = SceneCodec.encode(session.controller.scene)

    await #expect(throws: PhoneRecoveryPreparationError.unsavedDrawing(path)) {
      _ = try await fixture.workspace.resolveDrawingReview(review)
    }
    #expect(SceneCodec.encode(session.controller.scene) == liveScene)
    #expect(session.hasUncheckpointedEdits)
    #expect(try await fixture.workspace.drawingRepository.drawing(path)?.state == .needsReview)
    #expect(
      try await fixture.workspace.drawingRepository.drawing(path)?.content == review.drawing.content
    )
  }

  @Test(arguments: [true, false])
  func newAndUncertainStructuralChangesRefuseUncheckpointedInput(synchronizeFirst: Bool)
    async throws
  {
    let fixture = try DestructiveCheckpointFixture()
    defer { fixture.remove() }
    let original = try await fixture.workspace.repository.cache(
      RemoteNote(content: "Host text", version: "v1"), path: "Folder/Note.md")
    let session = NoteSession(note: original, repository: fixture.workspace.repository)
    fixture.workspace.sessions[original.path] = session
    fixture.workspace.active = session
    fixture.checkpoints.rejectWrites = true
    session.editor.input.insertText("New unsaved text ")
    let liveText = session.editor.text
    var dispatched = false

    await #expect(throws: PhoneRecoveryPreparationError.unsavedNote(original.path)) {
      try await fixture.workspace.withCheckpointedStructure(
        .trash(path: "Folder", isFolder: true), synchronizeFirst: synchronizeFirst
      ) {
        dispatched = true
        throw WorkspaceRepositoryError.connectionChanged
      }
    }
    #expect(!dispatched)
    #expect(!fixture.workspace.structuralBusy)
    #expect(fixture.workspace.active === session)
    #expect(session.editor.configuration.isEditable)
    #expect(session.editor.text == liveText)
    #expect(session.hasUncheckpointedEdits)
    #expect(try await fixture.workspace.repository.note(original.path)?.state == .synced)
  }
}

@MainActor
private struct DestructiveCheckpointFixture {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let index: SQLiteWorkspaceIndex
  let checkpoints: RejectingCheckpoints
  let workspace: PhoneWorkspace

  init() throws {
    let origin = try ConnectionOrigin("https://notes.example.test")
    var profile = ConnectionProfile(name: "Test host", origin: origin)
    profile.workspaceID = "test-workspace"
    profile.hostID = "test-host"
    let scope = WorkspaceScope(
      profileID: profile.id, workspaceID: "test-workspace", hostID: "test-host", origin: origin)
    index = try SQLiteWorkspaceIndex(url: root.appendingPathComponent("index.sqlite"), scope: scope)
    checkpoints = try RejectingCheckpoints(
      MarkdownCheckpointStore(directory: root.appendingPathComponent("markdown")))
    workspace = try PhoneWorkspace(
      rootDirectory: root,
      structural: WorkspaceStructuralCoordinator(rootDirectory: root, scope: scope),
      recovery: WorkspaceRecovery(rootDirectory: root, scope: scope), profile: profile,
      repository: WorkspaceRepository(scope: scope, index: index, checkpoints: checkpoints),
      drawingRepository: DrawingRepository(scope: scope, index: index, checkpoints: checkpoints),
      cache: WorkspaceCache(rootDirectory: root, scope: scope),
      captureOutbox: CaptureOutbox(rootDirectory: root, scope: scope))
  }

  func remove() { try? FileManager.default.removeItem(at: root) }
}

private final class RejectingCheckpoints: NoteCheckpointStore, @unchecked Sendable {
  private let wrapped: MarkdownCheckpointStore
  private let lock = NSLock()
  private var rejecting = false
  var rejectWrites: Bool {
    get { lock.withLock { rejecting } }
    set { lock.withLock { rejecting = newValue } }
  }
  init(_ wrapped: MarkdownCheckpointStore) { self.wrapped = wrapped }
  func beginAccess() throws -> CheckpointAccessLease? { try wrapped.beginAccess() }
  func put(_ content: String) throws -> String {
    if rejectWrites { throw WorkspaceRepositoryError.storage("Injected disk-full failure") }
    return try wrapped.put(content)
  }
  func read(_ reference: String) throws -> String { try wrapped.read(reference) }
  func fileURL(_ reference: String) throws -> URL { try wrapped.fileURL(reference) }
}
