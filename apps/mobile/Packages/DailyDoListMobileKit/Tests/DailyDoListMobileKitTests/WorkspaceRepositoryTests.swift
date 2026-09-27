import Foundation
import Testing

@testable import DailyDoListMobileKit

struct WorkspaceRepositoryTests {
  @Test func typingDuringACleanRemoteDeletionBecomesARecoveryDraftWithoutResurrection() async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.cache(RemoteNote(content: "Original", version: "v1"), path: "Gone.md")
    let remote = RepositoryRemote(scope: fixture.scope)
    #expect(try await repository.refresh(path: "Gone.md", with: remote) == nil)
    let recovered = try await repository.createRecoveryDraft(
      path: "Gone.md", content: "Typing during refresh")
    #expect(recovered.state == .recoveryDraft)
    #expect(recovered.reviewReason == .remoteDeleted)
    #expect(recovered.content == "Typing during refresh")
    _ = try await repository.synchronize(with: remote)
    #expect(await remote.writes.isEmpty)
    await #expect(throws: WorkspaceRepositoryError.documentNeedsReview) {
      try await repository.createRecoveryDraft(
        path: "Gone.md", content: "Cannot replace existing draft")
    }
  }

  @Test func liveEditorMergeConflictPreservesRemoteAndStopsAutomaticReplay() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let remoteVersion = try await repository.cache(
      RemoteNote(content: "Remote replacement", version: "v2"), path: "Day.md")
    let review = try await repository.saveForReview(
      path: "Day.md", content: "Unsaved typing",
      expectedRevision: remoteVersion.localRevision)
    #expect(review.state == .needsReview)
    #expect(review.content == "Unsaved typing")
    #expect(
      try review.recoveryCopies.map { try String(contentsOf: $0, encoding: .utf8) }.contains(
        "Remote replacement"))
    let remote = RepositoryRemote(
      scope: fixture.scope, note: RemoteNote(content: "Remote replacement", version: "v2"))
    _ = try await repository.synchronize(with: remote)
    #expect(await remote.writes.isEmpty)
    await #expect(
      throws: WorkspaceRepositoryError.staleRevision(
        expected: remoteVersion.localRevision, actual: review.localRevision)
    ) {
      try await repository.saveForReview(
        path: "Day.md", content: "Stale result", expectedRevision: remoteVersion.localRevision)
    }
  }

  @Test func offlineEditsAndCreateOnlyIntentSurviveRestart() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let first = try await repository.cache(
      RemoteNote(content: "# Day\nOriginal", version: "v1"), path: "Day.md")
    let edited = try await repository.edit(
      path: "Day.md",
      change: NoteTextChange(range: NSRange(location: 6, length: 8), replacement: "My plan 🌿"),
      expectedRevision: first.localRevision)
    _ = try await repository.create(path: "Ideas/New.md", content: "A new thought")
    let restarted = try fixture.open()
    let recovered = try #require(await restarted.note("Day.md"))
    #expect(recovered.content == "# Day\nMy plan 🌿")
    #expect(recovered.localRevision == edited.localRevision)
    #expect(recovered.state == .waitingToSync)
    #expect(try String(contentsOf: recovered.workingFile, encoding: .utf8) == recovered.content)
    let remote = RepositoryRemote(
      scope: fixture.scope, note: RemoteNote(content: "# Day\nOriginal", version: "v1"))
    _ = try await restarted.synchronize(with: remote)
    let writes = await remote.writes
    #expect(writes.first?.baseVersion == "v1")
    #expect(writes.last?.baseVersion == nil)
  }

  @Test func wrongWorkspaceCannotReplayAnOfflineEdit() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "New.md", content: "Private draft")
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.setIdentity(workspaceID: "different-workspace")
    await #expect(throws: WorkspaceRepositoryError.workspaceMismatch) {
      try await repository.synchronize(with: remote)
    }
    #expect(await remote.writes.isEmpty)
    #expect(try await repository.note("New.md")?.content == "Private draft")
  }

  @Test func newerTypingRemainsDirtyWhenAnEarlierRevisionIsAcknowledged() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let first = try await repository.create(path: "New.md", content: "First revision")
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.pauseNextWrite()
    let syncing = Task { try await repository.synchronize(with: remote) }
    await remote.waitForPausedWrite()
    let later = try await repository.save(
      path: "New.md", content: "First revision\nLater typing",
      expectedRevision: first.localRevision)
    await remote.setFailReadsAfterWrites(1)
    await remote.releaseWrite()
    await #expect(throws: TestNetworkError.self) { try await syncing.value }
    let current = try #require(await repository.note("New.md"))
    #expect(current.localRevision == later.localRevision)
    #expect(current.acknowledgedRevision == first.localRevision)
    #expect(current.state == .waitingToSync)
    #expect(current.content == "First revision\nLater typing")
    #expect(await remote.writes.first?.content == "First revision")
    await remote.setFailReadsAfterWrites(nil)
    _ = try await repository.synchronize(with: remote)
    #expect(await remote.notes["New.md"]?.content == current.content)
  }

  @Test func lostResponseIsReconciledAfterRestartWithoutAnotherWrite() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "New.md", content: "One task")
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.loseNextResponse()
    await #expect(throws: TestNetworkError.self) { try await repository.synchronize(with: remote) }
    let restarted = try fixture.open()
    _ = try await restarted.synchronize(with: remote)
    #expect(await remote.writes.count == 1)
    #expect(try await restarted.note("New.md")?.state == .synced)
  }

  @Test func uncertainWriteChangedByAnotherClientNeedsReviewInsteadOfDuplicatingTasks() async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "New.md", content: "- [ ] One task")
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.loseNextResponse()
    await #expect(throws: TestNetworkError.self) { try await repository.synchronize(with: remote) }
    await remote.replace(
      "New.md", with: RemoteNote(content: "- [x] One task", version: "another-version"))
    _ = try await repository.synchronize(with: remote)
    let note = try #require(await repository.note("New.md"))
    #expect(note.reviewReason == .uncertainWrite)
    #expect(note.content == "- [ ] One task")
    #expect(
      try String(contentsOf: #require(note.recoveryCopies.first), encoding: .utf8)
        == "- [x] One task")
    #expect(await remote.writes.count == 1)
  }

  @Test func dirtyDeletedNoteBecomesRecoveryAndNeverRecreatesItsOldPath() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let original = try await repository.cache(
      RemoteNote(content: "Original", version: "v1"), path: "Old.md")
    let edited = try await repository.save(
      path: "Old.md", content: "My changes", expectedRevision: original.localRevision)
    let remote = RepositoryRemote(scope: fixture.scope)
    _ = try await repository.synchronize(with: remote)
    let recovered = try #require(await repository.note("Old.md"))
    #expect(recovered.state == .recoveryDraft)
    #expect(await remote.writes.isEmpty)
    _ = try await repository.recover(
      path: "Old.md", as: "Recovered.md", expectedRevision: edited.localRevision)
    _ = try await repository.synchronize(with: remote)
    #expect(await remote.notes["Old.md"] == nil)
    #expect(await remote.notes["Recovered.md"]?.content == "My changes")
  }

  @Test func newNoteCollisionDoesNotOverwriteAnEqualOrDifferentExistingNote() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "Day.md", content: "Same words")
    let remote = RepositoryRemote(
      scope: fixture.scope, note: RemoteNote(content: "Same words", version: "existing"))
    _ = try await repository.synchronize(with: remote)
    #expect(try await repository.note("Day.md")?.reviewReason == .pathCollision)
    #expect(await remote.writes.isEmpty)
  }

  @Test func disjointRemoteEditsMergeWithoutResurrectingDeletedLines() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let initial = try await repository.cache(
      RemoteNote(content: "Heading\nDelete me\nLocal", version: "v1"), path: "Day.md")
    _ = try await repository.save(
      path: "Day.md", content: "Heading\nDelete me\nLocal typing",
      expectedRevision: initial.localRevision)
    let remote = RepositoryRemote(
      scope: fixture.scope, note: RemoteNote(content: "Heading\nLocal", version: "v2"))
    _ = try await repository.synchronize(with: remote)
    #expect(await remote.notes["Day.md"]?.content == "Heading\nLocal typing")
    #expect(await remote.writes.first?.baseVersion == "v2")
    #expect(try await repository.note("Day.md")?.state == .synced)
  }

  @Test func sameLineConflictKeepsBothVersionsUntilExplicitReview() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let initial = try await repository.cache(
      RemoteNote(content: "One line", version: "v1"), path: "Day.md")
    _ = try await repository.save(
      path: "Day.md", content: "My replacement", expectedRevision: initial.localRevision)
    let remote = RepositoryRemote(
      scope: fixture.scope, note: RemoteNote(content: "Remote replacement", version: "v2"))
    _ = try await repository.synchronize(with: remote)
    let conflict = try #require(await repository.note("Day.md"))
    #expect(conflict.state == .needsReview)
    #expect(conflict.content == "My replacement")
    #expect(await remote.writes.isEmpty)
    #expect(
      try String(contentsOf: #require(conflict.recoveryCopies.first), encoding: .utf8)
        == "Remote replacement")
    _ = try await repository.keepMergedEdits(
      path: "Day.md", expectedRevision: conflict.localRevision)
    _ = try await repository.synchronize(with: remote)
    #expect(await remote.notes["Day.md"]?.content == "My replacement")
  }

  @Test func definiteConditionalRejectionRefetchesAndMerges() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let initial = try await repository.cache(
      RemoteNote(content: "One\nTwo", version: "v1"), path: "Day.md")
    _ = try await repository.save(
      path: "Day.md", content: "One local\nTwo", expectedRevision: initial.localRevision)
    let remote = RepositoryRemote(
      scope: fixture.scope, note: RemoteNote(content: "One\nTwo", version: "v1"))
    await remote.rejectNextWrite(with: RemoteNote(content: "One\nTwo remote", version: "v2"))
    _ = try await repository.synchronize(with: remote)
    #expect(await remote.notes["Day.md"]?.content == "One local\nTwo remote")
  }

  @Test func connectionReplacementRejectsAnOldAcknowledgementAndLaterReconcilesIt() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "New.md", content: "My note")
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.pauseNextWrite()
    let sync = Task { try await repository.synchronize(with: remote) }
    await remote.waitForPausedWrite()
    await repository.invalidateConnection()
    await remote.releaseWrite()
    await #expect(throws: WorkspaceRepositoryError.connectionChanged) { try await sync.value }
    #expect(try await repository.note("New.md")?.state == .waitingToSync)
    _ = try await repository.synchronize(with: remote)
    #expect(try await repository.note("New.md")?.state == .synced)
    #expect(await remote.writes.count == 1)
  }

  @Test func staleCheckpointCannotReplaceNewerTypingAndDirtyCacheWinsOverFetch() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let initial = try await repository.create(path: "New.md", content: "First")
    let edited = try await repository.save(
      path: "New.md", content: "Second", expectedRevision: initial.localRevision)
    await #expect(
      throws: WorkspaceRepositoryError.staleRevision(
        expected: initial.localRevision, actual: edited.localRevision)
    ) {
      try await repository.save(
        path: "New.md", content: "Stale", expectedRevision: initial.localRevision)
    }
    let cached = try await repository.cache(
      RemoteNote(content: "Old server text", version: "v1"), path: "New.md")
    #expect(cached.content == "Second")
  }
}

struct RepositoryFixture {
  let directory: URL
  let scope: WorkspaceScope

  init() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ddl-repository-test-" + UUID().uuidString)
    scope = WorkspaceScope(
      profileID: UUID(), workspaceID: "synthetic-workspace", hostID: "synthetic-host",
      origin: try ConnectionOrigin("https://notes.example.test"))
  }

  func open() throws -> WorkspaceRepository {
    try WorkspaceRepository(rootDirectory: directory, scope: scope)
  }
  func remove() { try? FileManager.default.removeItem(at: directory) }
}

enum TestNetworkError: Error { case disconnected }

actor RepositoryRemote: WorkspaceRemote {
  nonisolated let profileID: UUID
  nonisolated let origin: ConnectionOrigin
  var reportedIdentity: RemoteWorkspaceIdentity
  var notes: [String: RemoteNote]
  struct Write: Sendable {
    let content: String
    let baseVersion: String?
  }
  var writes: [Write] = []
  var loseResponse = false
  var rejectWith: RemoteNote?
  var shouldPause = false
  var pauseContinuation: CheckedContinuation<Void, Never>?
  var pauseObservers: [CheckedContinuation<Void, Never>] = []
  var failReadsAfterWrites: Int?

  init(scope: WorkspaceScope, note: RemoteNote? = nil) {
    profileID = scope.profileID
    origin = scope.origin
    reportedIdentity = RemoteWorkspaceIdentity(
      workspaceID: scope.workspaceID, hostID: scope.hostID,
      supportsConditionalWorkspaceWrites: true)
    notes = note.map { ["Day.md": $0] } ?? [:]
  }

  func identity() -> RemoteWorkspaceIdentity { reportedIdentity }
  func setIdentity(workspaceID: String) { reportedIdentity.workspaceID = workspaceID }
  func replace(_ path: String, with note: RemoteNote) { notes[path] = note }
  func loseNextResponse() { loseResponse = true }
  func rejectNextWrite(with note: RemoteNote) { rejectWith = note }
  func pauseNextWrite() { shouldPause = true }
  func setFailReadsAfterWrites(_ count: Int?) { failReadsAfterWrites = count }

  func waitForPausedWrite() async {
    if pauseContinuation != nil { return }
    await withCheckedContinuation { pauseObservers.append($0) }
  }

  func releaseWrite() {
    pauseContinuation?.resume()
    pauseContinuation = nil
  }

  func readNote(_ path: String) throws -> RemoteNote? {
    if let failReadsAfterWrites, writes.count >= failReadsAfterWrites {
      throw TestNetworkError.disconnected
    }
    return notes[path]
  }

  func writeNote(_ path: String, content: String, baseVersion: String?, workspaceID: String)
    async throws -> RemoteNote
  {
    guard workspaceID == reportedIdentity.workspaceID else {
      throw WorkspaceRemoteError.workspaceChanged
    }
    if let rejectWith {
      self.rejectWith = nil
      notes[path] = rejectWith
      throw WorkspaceRemoteError.conflict
    }
    guard notes[path]?.version == baseVersion else { throw WorkspaceRemoteError.conflict }
    writes.append(Write(content: content, baseVersion: baseVersion))
    if shouldPause {
      shouldPause = false
      await withCheckedContinuation { continuation in
        pauseContinuation = continuation
        for observer in pauseObservers { observer.resume() }
        pauseObservers = []
      }
    }
    let result = RemoteNote(content: content, version: "saved-\(writes.count)")
    notes[path] = result
    if loseResponse {
      loseResponse = false
      throw TestNetworkError.disconnected
    }
    return result
  }
}
