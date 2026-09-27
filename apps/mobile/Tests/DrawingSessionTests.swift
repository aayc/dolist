import DailyDoListDrawingModel
import DailyDoListMobileKit
import Foundation
import Testing

@testable import DailyDoList

@MainActor
struct DrawingSessionTests {
  @Test func recoveryPreparationRefusesAnUnpersistedLiveDrawing() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let scope = WorkspaceScope(
      profileID: UUID(), workspaceID: "workspace", hostID: "host",
      origin: try ConnectionOrigin("https://notes.example.test"))
    let repository = try DrawingRepository(rootDirectory: root, scope: scope)
    let path = "Sketch.excalidraw.md"
    let original = try await repository.cache(
      RemoteNote(
        content: ExcalidrawMarkdown.serialize(ExcalidrawScene(), previous: nil), version: "v1"),
      path: path)
    let session = DrawingSession(drawing: original, repository: repository)
    let recovery = try WorkspaceRecovery(rootDirectory: root, scope: scope)
    try await recovery.discardLocalNote(path: path, expectedRevision: original.localRevision)
    session.controller.editor.tool = .rectangle
    session.controller.editor.pointerDown(at: .init(10, 10))
    session.controller.editor.pointerDragged(to: .init(60, 50))
    session.controller.finishEditing()
    await session.checkpoint()
    #expect(session.hasUncheckpointedEdits)
    #expect(throws: PhoneRecoveryPreparationError.unsavedDrawing(path)) {
      try PhoneRecoveryPreparation.validate(notes: [], drawings: [session])
    }
  }

  @Test func malformedArrivalDuringGesturePreservesBothOriginalsAtBackgroundCheckpoint()
    async throws
  {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let repository = try DrawingRepository(
      rootDirectory: root,
      scope: WorkspaceScope(
        profileID: UUID(), workspaceID: "test-workspace", hostID: "test-host",
        origin: ConnectionOrigin("https://notes.example.test")))
    let path = "Sketch.excalidraw.md"
    let original = try await repository.cache(
      RemoteNote(
        content: ExcalidrawMarkdown.serialize(ExcalidrawScene(), previous: nil), version: "v1"),
      path: path)
    let session = DrawingSession(drawing: original, repository: repository)
    session.controller.editor.tool = .rectangle
    session.controller.editor.pointerDown(at: .init(10, 10))
    session.controller.editor.pointerDragged(to: .init(60, 50))
    let malformed = "## Drawing\n```json\nnot valid JSON\n```\n"
    let incoming = try await repository.cache(
      RemoteNote(content: malformed, version: "v2"), path: path)
    await session.adopt(incoming)
    // Background saving must work even before the deferred interaction-end callback can run.
    session.controller.onInteractionEnd = nil
    session.controller.finishEditing()
    await session.checkpoint()
    let durable = try #require(try await repository.drawing(path))
    #expect(durable.document.scene.visibleElements.count == 1)
    #expect(durable.state == .needsReview)
    #expect(durable.reviewReason == .invalidDrawing)
    #expect(try await repository.review(path)?.hostContent == malformed)
    #expect(
      try durable.recoveryCopies.map { try String(contentsOf: $0, encoding: .utf8) }.contains(
        malformed))
    #expect(!session.hasUncheckpointedEdits)
    #expect(session.error == nil)
  }

  @Test func incomingScenesWaitForGestureAndBackgroundCheckpointKeepsBothSides() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let repository = try DrawingRepository(
      rootDirectory: root,
      scope: WorkspaceScope(
        profileID: UUID(), workspaceID: "test-workspace", hostID: "test-host",
        origin: ConnectionOrigin("https://notes.example.test")))
    let path = "Sketch.excalidraw.md"
    func file(_ scene: ExcalidrawScene) throws -> String {
      try ExcalidrawMarkdown.serialize(scene, previous: nil)
    }
    let original = try await repository.cache(
      RemoteNote(content: file(ExcalidrawScene()), version: "v1"), path: path)
    let session = DrawingSession(drawing: original, repository: repository)
    session.controller.editor.tool = .rectangle
    session.controller.editor.pointerDown(at: .init(10, 10))
    session.controller.editor.pointerDragged(to: .init(60, 50))
    let remoteShape = ExcalidrawElement(id: "remote", type: .ellipse)
    let incoming = try await repository.cache(
      RemoteNote(content: file(ExcalidrawScene(elements: [remoteShape])), version: "v2"),
      path: path)
    await session.adopt(incoming)
    var newerShape = remoteShape
    newerShape.x = 200
    newerShape.version += 1
    let latest = try await repository.cache(
      RemoteNote(content: file(ExcalidrawScene(elements: [newerShape])), version: "v3"),
      path: path)
    await session.adopt(latest)
    await session.checkpoint()
    #expect(session.drawing.localRevision == original.localRevision)
    #expect(session.controller.hasActiveInteraction)
    #expect(session.controller.scene.element(id: "remote") == nil)

    let (saved, continuation) = AsyncStream<Void>.makeStream()
    session.onCheckpoint = { continuation.yield(()) }
    session.controller.finishEditing()
    var iterator = saved.makeAsyncIterator()
    _ = await iterator.next()
    continuation.finish()
    let durable = try #require(try await repository.drawing(path))
    #expect(durable.document.scene.elements.filter { !$0.isDeleted }.count == 2)
    #expect(durable.document.scene.element(id: "remote")?.x == 200)
    #expect(durable.document.scene.elements.first { $0.type == .rectangle }?.width == 50)
    #expect(durable.state == .waitingToSync)
    #expect(!session.hasUncheckpointedEdits)
    #expect(!session.controller.hasActiveInteraction)

    let visibleBeforeStaleArrival = session.controller.scene
    await session.adopt(incoming)
    #expect(session.controller.scene == visibleBeforeStaleArrival)

    await session.adopt(durable)
    #expect(!session.hasUncheckpointedEdits)
    var redundantSaves = 0
    session.onCheckpoint = { redundantSaves += 1 }
    await session.checkpoint()
    #expect(redundantSaves == 0)
  }
}
