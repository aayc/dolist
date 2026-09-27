import DailyDoListDrawingModel
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct CheckpointAccessTests {
  @Test(arguments: [false, true])
  func unpublishedNoteAndDrawingFilesRemainProtectedUntilIndexCommit(drawing: Bool) async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let directory = fixture.directory.appendingPathComponent("markdown")
    let files = try MarkdownCheckpointStore(directory: directory)
    let otherHandle = try MarkdownCheckpointStore(directory: directory)
    let gate = CheckpointPublicationGate()
    let probe = PausedCheckpointStore(wrapped: files, gate: gate)
    let index = try SQLiteWorkspaceIndex(
      url: fixture.directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let path = drawing ? "New.excalidraw.md" : "New.md"
    let writing = Task {
      if drawing {
        let repository = DrawingRepository(scope: fixture.scope, index: index, checkpoints: probe)
        _ = try await repository.create(path: path)
      } else {
        let repository = try WorkspaceRepository(
          scope: fixture.scope, index: index, checkpoints: probe)
        _ = try await repository.create(path: path, content: "Unpublished synthetic text")
      }
    }
    await gate.entered()
    defer { gate.release() }
    #expect(try index.document(path) == nil)
    let prematureCleanup = try otherHandle.beginExclusiveAccess()
    #expect(prematureCleanup == nil)
    prematureCleanup?.release()
    gate.release()
    try await writing.value
    let record = try #require(try index.document(path))
    #expect(try !otherHandle.read(record.working).isEmpty)
    let cleanup = try #require(try otherHandle.beginExclusiveAccess())
    cleanup.release()
  }

  @Test func aRemovedAndRecreatedPathCannotReuseAnEditorRevisionOrMetadataGeneration() async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let files = try MarkdownCheckpointStore(
      directory: fixture.directory.appendingPathComponent("markdown"))
    let index = try SQLiteWorkspaceIndex(
      url: fixture.directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let repository = try WorkspaceRepository(scope: fixture.scope, index: index, checkpoints: files)
    let original = try await repository.cache(
      RemoteNote(content: "Original", version: "v1"), path: "Read.md")
    let oldRecord = try #require(try index.document("Read.md"))
    try index.commit(
      path: "Read.md", document: nil, pending: nil, expectedGeneration: oldRecord.generation)
    let replacement = try await repository.cache(
      RemoteNote(content: "New server text", version: "v2"), path: "Read.md")
    #expect(replacement.localRevision > original.localRevision)
    await #expect(
      throws: WorkspaceRepositoryError.staleRevision(
        expected: original.localRevision, actual: replacement.localRevision)
    ) {
      try await repository.save(
        path: "Read.md", content: "Old editor", expectedRevision: original.localRevision)
    }
    #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try index.commit(oldRecord, pending: nil)
    }
    let latest = try #require(try index.document("Read.md"))
    try index.commit(
      path: "Read.md", document: nil, pending: nil, expectedGeneration: latest.generation)
    let newDraft = try await repository.create(path: "Read.md", content: "Explicit new draft")
    #expect(newDraft.localRevision > replacement.localRevision)
    #expect(try await repository.note("Read.md")?.content == "Explicit new draft")
  }
}

private struct PausedCheckpointStore: NoteCheckpointStore {
  let wrapped: MarkdownCheckpointStore
  let gate: CheckpointPublicationGate
  func beginAccess() throws -> CheckpointAccessLease? { try wrapped.beginAccess() }
  func put(_ content: String) throws -> String {
    let result = try wrapped.put(content)
    gate.pauseOnce()
    return result
  }
  func read(_ reference: String) throws -> String { try wrapped.read(reference) }
  func fileURL(_ reference: String) throws -> URL { try wrapped.fileURL(reference) }
}

private final class CheckpointPublicationGate: @unchecked Sendable {
  private let lock = NSLock()
  private let semaphore = DispatchSemaphore(value: 0)
  private var paused = false
  private var observer: CheckedContinuation<Void, Never>?
  func pauseOnce() {
    lock.lock()
    if paused {
      lock.unlock()
      return
    }
    paused = true
    let observer = self.observer
    self.observer = nil
    lock.unlock()
    observer?.resume()
    semaphore.wait()
  }
  func entered() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      if paused {
        lock.unlock()
        continuation.resume()
      } else {
        observer = continuation
        lock.unlock()
      }
    }
  }
  func release() { semaphore.signal() }
}
