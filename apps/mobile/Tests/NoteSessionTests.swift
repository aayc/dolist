import DailyDoListMobileKit
import Foundation
import Testing
import UIKit

@testable import DailyDoList

@MainActor
struct NoteSessionTests {
  @Test func incomingSnapshotRebasesUncheckpointedTypingAndKeepsNewerTyping() async throws {
    let fixture = try NoteSessionFixture()
    defer { fixture.remove() }
    let original = try await fixture.repository.cache(
      RemoteNote(content: "First\nSecond", version: "v1"), path: "Note.md")
    let session = NoteSession(note: original, repository: fixture.repository)
    session.editor.selection = NSRange(location: 5, length: 0)
    session.editor.input.insertText(" local")
    let incoming = try await fixture.repository.cache(
      RemoteNote(content: "First\nSecond remote", version: "v2"), path: "Note.md")
    await session.adopt(incoming)
    #expect(session.editor.text == "First local\nSecond remote")
    session.editor.input.insertText(" later")
    await session.checkpoint()
    #expect(
      try await fixture.repository.note("Note.md")?.content == "First local later\nSecond remote")
    #expect(session.note.state == .waitingToSync)
    #expect(!session.hasUncheckpointedEdits)
  }

  @Test func overlappingLiveTypingIsDurableButNeverAutomaticallyQueued() async throws {
    let fixture = try NoteSessionFixture()
    defer { fixture.remove() }
    let original = try await fixture.repository.cache(
      RemoteNote(content: "Original", version: "v1"), path: "Note.md")
    let session = NoteSession(note: original, repository: fixture.repository)
    session.editor.selection = NSRange(location: 0, length: 8)
    session.editor.input.insertText("Local")
    let incoming = try await fixture.repository.cache(
      RemoteNote(content: "Remote", version: "v2"), path: "Note.md")
    await session.adopt(incoming)
    #expect(session.note.state == .needsReview)
    #expect(session.editor.text.contains("Local"))
    session.editor.input.insertText(" continued")
    await session.checkpoint()
    let saved = try #require(try await fixture.repository.note("Note.md"))
    #expect(saved.state == .needsReview)
    #expect(saved.content == session.editor.text)
    #expect(
      try saved.recoveryCopies.map { try String(contentsOf: $0, encoding: .utf8) }.contains(
        "Remote"))
  }

  @Test func markedTextDefersTheWholeRebaseUntilCompositionEnds() async throws {
    let fixture = try NoteSessionFixture()
    defer { fixture.remove() }
    let original = try await fixture.repository.cache(
      RemoteNote(content: "Local\nRemote", version: "v1"), path: "Note.md")
    let session = NoteSession(note: original, repository: fixture.repository)
    session.editor.selection = NSRange(location: 5, length: 0)
    session.editor.input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    let incoming = try await fixture.repository.cache(
      RemoteNote(content: "Local\nRemote update", version: "v2"), path: "Note.md")
    await session.adopt(incoming)
    await session.checkpoint()
    #expect(session.note.localRevision == original.localRevision)
    session.editor.input.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0))
    let (saved, continuation) = AsyncStream<Void>.makeStream()
    session.onCheckpoint = { continuation.yield(()) }
    session.editor.input.unmarkText()
    var iterator = saved.makeAsyncIterator()
    _ = await iterator.next()
    continuation.finish()
    #expect(session.editor.text == "Local日本\nRemote update")
    #expect(try await fixture.repository.note("Note.md")?.content == session.editor.text)
  }

  @Test func choosingTheReviewedHostVersionDoesNotMergeRejectedTextBackIn() async throws {
    let fixture = try NoteSessionFixture()
    defer { fixture.remove() }
    let original = try await fixture.repository.cache(
      RemoteNote(content: "Host", version: "v1"), path: "Note.md")
    let session = NoteSession(note: original, repository: fixture.repository)
    session.editor.selection = NSRange(location: 0, length: 4)
    session.editor.input.insertText("Local")
    await session.checkpoint()
    let parked = try await fixture.repository.saveForReview(
      path: "Note.md", content: "Local", expectedRevision: session.note.localRevision)
    await session.adopt(parked)
    let chosen = try await fixture.repository.useRemoteVersion(
      path: "Note.md", expectedRevision: session.note.localRevision)
    session.adoptReviewed(chosen)
    await session.checkpoint()
    #expect(session.editor.text == "Host")
    #expect(session.note.state == .synced)
    #expect(!session.hasUncheckpointedEdits)
    #expect(
      try chosen.recoveryCopies.map { try String(contentsOf: $0, encoding: .utf8) }.contains(
        "Local"))
  }

  @Test func recoveryPreparationRefusesLiveTextAfterCheckpointFailure() async throws {
    let fixture = try NoteSessionFixture()
    defer { fixture.remove() }
    let original = try await fixture.repository.create(path: "Draft.md", content: "Original")
    let session = NoteSession(note: original, repository: fixture.repository)
    let recovery = try WorkspaceRecovery(
      rootDirectory: fixture.root, scope: fixture.repository.scope)
    try await recovery.discardLocalNote(path: "Draft.md", expectedRevision: original.localRevision)
    session.editor.input.insertText("Unsaved text")
    await session.checkpoint()
    #expect(session.hasUncheckpointedEdits)
    #expect(throws: PhoneRecoveryPreparationError.unsavedNote("Draft.md")) {
      try PhoneRecoveryPreparation.validate(notes: [session], drawings: [])
    }
  }

}

private struct NoteSessionFixture {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  let repository: WorkspaceRepository
  init() throws {
    repository = try WorkspaceRepository(
      rootDirectory: root,
      scope: WorkspaceScope(
        profileID: UUID(), workspaceID: "test-workspace", hostID: "test-host",
        origin: ConnectionOrigin("https://notes.example.test")))
  }
  func remove() { try? FileManager.default.removeItem(at: root) }
}
