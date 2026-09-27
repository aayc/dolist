import DailyDoListDrawingModel
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct DrawingRepositoryTests {
  @Test func aCreateOnlyDrawingCollisionDoesNotOverwriteAnEqualExistingFile() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let created = try await drawings.create(path: "Existing.excalidraw.md", scene: scene("shape"))
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.replace(
      created.path, with: RemoteNote(content: created.content, version: "already-exists"))
    _ = try await drawings.synchronize(with: remote)
    #expect(try await drawings.drawing(created.path)?.reviewReason == .pathCollision)
    #expect(await remote.writes.isEmpty)
  }

  @Test func aLateNoteAcknowledgementCannotClearANewDrawingDependency() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let first = try await drawings.create(path: "First.excalidraw.md")
    let remote = RepositoryRemote(scope: fixture.scope)
    _ = try await drawings.synchronize(with: remote)
    let notes = try fixture.open()
    let note = try await notes.create(
      path: "Note.md", content: "![[First.excalidraw.md]]", requiringDrawings: [first.path])
    await remote.pauseNextWrite()
    let syncing = Task { try await notes.synchronize(with: remote) }
    await remote.waitForPausedWrite()
    let second = try await drawings.create(path: "Second.excalidraw.md")
    let later = try await notes.save(
      path: note.path, content: note.content + "\n![[Second.excalidraw.md]]",
      expectedRevision: note.localRevision, requiringDrawings: [first.path, second.path])
    await remote.releaseWrite()
    _ = try await syncing.value
    #expect(try await notes.note(note.path)?.state == .waitingToSync)
    #expect(await remote.notes[note.path]?.content == note.content)
    let structural = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    await #expect(throws: WorkspaceRepositoryError.pendingDrawingDependencies) {
      try await structural.perform(
        .rename(from: second.path, to: "Other.excalidraw.md", isFolder: false),
        with: StructuralTestRemote(scope: fixture.scope))
    }
    _ = try await drawings.synchronize(with: remote)
    _ = try await notes.synchronize(with: remote)
    #expect(await remote.notes[note.path]?.content == later.content)
  }

  @Test func newDrawingSurvivesRestartAndItsEmbedWaitsForAcknowledgedCreation() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let drawing = try await drawings.create(path: "Sketch.excalidraw.md", scene: scene("shape"))
    let notes = try fixture.open()
    _ = try await notes.create(
      path: "Note.md", content: "![[Sketch.excalidraw.md]]", requiringDrawings: [drawing.path])
    let remote = RepositoryRemote(scope: fixture.scope)
    _ = try await notes.synchronize(with: remote)
    #expect(await remote.writes.isEmpty)
    #expect(try await notes.notes().map(\.path) == ["Note.md"])
    let restarted = try fixture.drawings()
    #expect(try await restarted.drawing(drawing.path)?.document.scene.element(id: "shape") != nil)
    await remote.loseNextResponse()
    await #expect(throws: TestNetworkError.self) { try await restarted.synchronize(with: remote) }
    _ = try await notes.synchronize(with: remote)
    #expect(await remote.notes["Note.md"] == nil)
    _ = try await restarted.synchronize(with: remote)
    #expect(await remote.writes.count == 1)
    _ = try await notes.synchronize(with: remote)
    #expect(await remote.notes["Note.md"]?.content == "![[Sketch.excalidraw.md]]")
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    #expect(
      try await coordinator.perform(
        .rename(from: drawing.path, to: "Moved.excalidraw.md", isFolder: false),
        with: StructuralTestRemote(scope: fixture.scope)
      ).state == .applied)
    #expect(try await restarted.drawing("Moved.excalidraw.md")?.state == .synced)
  }

  @Test func sceneMergeCombinesIndependentEditsAndHonorsRemoteRemovalWithoutLosingSections()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let base = scene("one", "two", "removed")
    let original = try await drawings.cache(
      RemoteNote(content: drawingFile(base), version: "v1"), path: "Sketch.excalidraw.md")
    var local = original.document.scene
    local.elements[0].x = 20
    local.elements[0].version = 2
    _ = try await drawings.save(
      path: original.path, scene: local, expectedRevision: original.localRevision)
    var remoteScene = base
    remoteScene.elements[1].y = 30
    remoteScene.elements[1].version = 2
    remoteScene.elements.removeLast()
    let remoteText = try drawingFile(remoteScene) + "\n## Extra\nKeep this remote section\n"
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.replace(original.path, with: RemoteNote(content: remoteText, version: "v2"))
    _ = try await drawings.synchronize(with: remote)
    let content = try #require(await remote.notes[original.path]?.content)
    let merged = ExcalidrawMarkdown.parse(content).scene
    #expect(merged.element(id: "one")?.x == 20)
    #expect(merged.element(id: "two")?.y == 30)
    #expect(merged.element(id: "removed") == nil)
    #expect(content.contains("Keep this remote section"))
    #expect(await remote.writes.first?.baseVersion == "v2")
  }

  @Test func anUnchangedCanvasDoesNotReformatOrWriteACompressedOriginal() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let file = try ExcalidrawMarkdown.serialize(scene("shape"), previous: nil, compressed: true)
    let original = try await drawings.cache(
      RemoteNote(content: file, version: "v1"), path: "Sketch.excalidraw.md")
    let unchanged = try await drawings.save(
      path: original.path, scene: original.document.scene, expectedRevision: original.localRevision)
    #expect(unchanged.localRevision == original.localRevision)
    #expect(unchanged.content == file)
    let remote = RepositoryRemote(scope: fixture.scope)
    _ = try await drawings.synchronize(with: remote)
    #expect(await remote.writes.isEmpty)
  }

  @Test(arguments: [
    "## Drawing\n```json\nnot-json\n```\n",
    "## Drawing\n```json\n{\"type\":\"excalidraw\",\"version\":99,\"elements\":[]}\n```\n",
    "## Drawing\n```json\n{\"elements\":[{\"type\":\"rectangle\"}]}\n```\n",
    "## Drawing\n```json\n{\"version\":\"future\",\"elements\":[]}\n```\n",
    "## Drawing\n```json\n{\"elements\":[],\"files\":\"unrecognized-format\"}\n```\n",
  ])
  func malformedAndUnsupportedOriginalsRemainExactAndNeverBecomeEmptyWritableScenes(
    _ content: String
  ) async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let original = try await drawings.cache(
      RemoteNote(content: content, version: "v1"), path: "Bad.excalidraw.md")
    #expect(original.canEdit == false)
    #expect(original.content == content)
    #expect(original.state == .needsReview)
    await #expect(throws: DrawingRepositoryError.self) {
      try await drawings.save(
        path: original.path, scene: ExcalidrawScene(), expectedRevision: original.localRevision)
    }
    let remote = RepositoryRemote(scope: fixture.scope)
    _ = try await drawings.synchronize(with: remote)
    #expect(await remote.writes.isEmpty)
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    let exported = try await recovery.export(to: fixture.directory)
    let entry = try #require(exported.manifest.entries.first { $0.kind == "working" })
    #expect(
      try String(
        contentsOf: exported.directory.appendingPathComponent(entry.relativePath), encoding: .utf8)
        == content)
  }

  @Test func unsupportedElementsStayVerbatimWhileSupportedElementsCanChange() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    var originalScene = scene("shape")
    var unknown = ExcalidrawElement(id: "future", type: ElementType(rawValue: "future-widget"))
    unknown.setExtraField("futureData", .string("Preserve this"))
    originalScene.elements.append(unknown)
    let original = try await drawings.cache(
      RemoteNote(content: drawingFile(originalScene), version: "v1"), path: "Mixed.excalidraw.md")
    var changed = original.document.scene
    changed.elements[0].x = 10
    changed.elements[0].version += 1
    let saved = try await drawings.save(
      path: original.path, scene: changed, expectedRevision: original.localRevision)
    #expect(
      saved.document.scene.element(id: "future") == original.document.scene.element(id: "future"))
    changed.elements.removeLast()
    await #expect(throws: DrawingRepositoryError.unsupportedElementChanged) {
      try await drawings.save(
        path: original.path, scene: changed, expectedRevision: saved.localRevision)
    }
  }

  @Test func malformedRemoteDuringAnOfflineEditKeepsBothFilesAndNeverOverwritesIt() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let original = try await drawings.cache(
      RemoteNote(content: drawingFile(scene("shape")), version: "v1"), path: "Sketch.excalidraw.md")
    var changed = original.document.scene
    changed.elements[0].x = 15
    changed.elements[0].version += 1
    _ = try await drawings.save(
      path: original.path, scene: changed, expectedRevision: original.localRevision)
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.replace(
      original.path, with: RemoteNote(content: "Malformed original stays here", version: "v2"))
    _ = try await drawings.synchronize(with: remote)
    let review = try #require(await drawings.drawing(original.path))
    #expect(review.reviewReason == .invalidDrawing)
    #expect(review.document.scene.element(id: "shape")?.x == 15)
    #expect(
      try review.recoveryCopies.map { try String(contentsOf: $0, encoding: .utf8) }.contains(
        "Malformed original stays here"))
    #expect(await remote.writes.isEmpty)
    _ = try await drawings.recover(
      path: original.path, as: "Recovered.excalidraw.md", expectedRevision: review.localRevision)
    _ = try await drawings.synchronize(with: remote)
    #expect(await remote.notes[original.path]?.content == "Malformed original stays here")
    #expect(await remote.notes["Recovered.excalidraw.md"] != nil)
  }

  @Test func aRemoteDeletedDrawingRetainsLocalSceneWithoutResurrectingItsOldPath() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let original = try await drawings.cache(
      RemoteNote(content: drawingFile(scene("shape")), version: "v1"), path: "Gone.excalidraw.md")
    var changed = original.document.scene
    changed.elements[0].x = 90
    changed.elements[0].version += 1
    _ = try await drawings.save(
      path: original.path, scene: changed, expectedRevision: original.localRevision)
    let remote = RepositoryRemote(scope: fixture.scope)
    _ = try await drawings.synchronize(with: remote)
    #expect(try await drawings.drawing(original.path)?.state == .recoveryDraft)
    #expect(await remote.writes.isEmpty)
  }

  @Test func drawingAddedDuringAnEarlierSendStaysDirtyWhenTheOldRevisionIsAcknowledged()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let original = try await drawings.create(path: "Sketch.excalidraw.md", scene: scene("one"))
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.pauseNextWrite()
    let syncing = Task { try await drawings.synchronize(with: remote) }
    await remote.waitForPausedWrite()
    var changed = original.document.scene
    changed.elements.append(ExcalidrawElement(id: "two", type: .ellipse))
    let later = try await drawings.save(
      path: original.path, scene: changed, expectedRevision: original.localRevision)
    await remote.setFailReadsAfterWrites(1)
    await remote.releaseWrite()
    await #expect(throws: TestNetworkError.self) { try await syncing.value }
    let pending = try #require(await drawings.drawing(original.path))
    #expect(pending.localRevision == later.localRevision)
    #expect(pending.acknowledgedRevision == original.localRevision)
    #expect(pending.state == .waitingToSync)
    #expect(pending.document.scene.elements.count == 2)
    await remote.setFailReadsAfterWrites(nil)
    _ = try await drawings.synchronize(with: remote)
    #expect(try await drawings.drawing(original.path)?.state == .synced)
  }

  @Test func capturesWaitForAttemptedDrawingsButPreventUnattemptedDrawingWrites() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    _ = try await drawings.create(path: "Z.excalidraw.md", scene: scene("z"))
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.loseNextResponse()
    await #expect(throws: TestNetworkError.self) { try await drawings.synchronize(with: remote) }
    _ = try await drawings.create(path: "A.excalidraw.md", scene: scene("a"))
    let captures = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await captures.enqueue(
      text: "Task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    let captureRemote = CaptureTestRemote(scope: fixture.scope)
    await #expect(throws: WorkspaceRepositoryError.pendingNoteWrites) {
      try await captures.synchronize(with: captureRemote)
    }
    _ = try await drawings.synchronize(with: remote)
    #expect(try await drawings.drawing("Z.excalidraw.md")?.state == .synced)
    #expect(try await drawings.drawing("A.excalidraw.md")?.state == .waitingToSync)
    _ = try await captures.synchronize(with: captureRemote)
    _ = try await drawings.synchronize(with: remote)
    #expect(try await drawings.drawing("A.excalidraw.md")?.state == .synced)
  }

  @Test func changedWorkspaceCannotReceiveOfflineDrawingReplay() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    _ = try await drawings.create(path: "Sketch.excalidraw.md")
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.setIdentity(workspaceID: "different-workspace")
    await #expect(throws: WorkspaceRepositoryError.workspaceMismatch) {
      try await drawings.synchronize(with: remote)
    }
    #expect(await remote.writes.isEmpty)
  }

  @Test func anUncertainDrawingWriteChangedElsewhereStopsForReviewInsteadOfResending() async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let original = try await drawings.create(path: "Sketch.excalidraw.md", scene: scene("local"))
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.loseNextResponse()
    await #expect(throws: TestNetworkError.self) { try await drawings.synchronize(with: remote) }
    let other = try drawingFile(scene("remote"))
    await remote.replace(original.path, with: RemoteNote(content: other, version: "intervening"))
    let reopened = try fixture.drawings()
    _ = try await reopened.synchronize(with: remote)
    let review = try #require(await reopened.drawing(original.path))
    #expect(review.reviewReason == .uncertainWrite)
    #expect(review.document.scene.element(id: "local") != nil)
    #expect(
      try review.recoveryCopies.map { try String(contentsOf: $0, encoding: .utf8) }.contains(other))
    #expect(await remote.writes.count == 1)
  }

  @Test func newCanvasInputAfterACleanRemoteDeletionCanBeRecoveredWithoutRecreatingThePath()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let drawings = try fixture.drawings()
    let original = try await drawings.cache(
      RemoteNote(content: drawingFile(scene("first")), version: "v1"), path: "Gone.excalidraw.md")
    let remote = RepositoryRemote(scope: fixture.scope)
    #expect(try await drawings.refresh(path: original.path, with: remote) == nil)
    var changed = original.document.scene
    changed.elements.append(ExcalidrawElement(id: "new", type: .rectangle))
    let recovery = try await drawings.createRecoveryDraft(
      path: original.path, scene: changed, previous: original.document)
    #expect(recovery.state == .recoveryDraft)
    _ = try await drawings.synchronize(with: remote)
    #expect(await remote.writes.isEmpty)
    #expect(try await drawings.drawing(original.path)?.document.scene.element(id: "new") != nil)
  }
}

extension RepositoryFixture {
  func drawings() throws -> DrawingRepository {
    try DrawingRepository(rootDirectory: directory, scope: scope)
  }
}

private func scene(_ ids: String...) -> ExcalidrawScene {
  ExcalidrawScene(elements: ids.map { ExcalidrawElement(id: $0, type: .rectangle) })
}

private func drawingFile(_ scene: ExcalidrawScene) throws -> String {
  try ExcalidrawMarkdown.serialize(scene, previous: nil)
}
