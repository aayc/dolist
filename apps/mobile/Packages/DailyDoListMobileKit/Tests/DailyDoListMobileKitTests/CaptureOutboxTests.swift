import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct CaptureOutboxTests {
  @Test func anEarlierUnsentPathCannotBlockResolvingALaterAttemptForCapture() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "Z.md", content: "Already attempted")
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.loseNextResponse()
    await #expect(throws: TestNetworkError.self) { try await repository.synchronize(with: remote) }
    _ = try await repository.create(path: "A.md", content: "Not attempted yet")
    let captures = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await captures.enqueue(
      text: "Captured task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    _ = try await repository.synchronize(with: remote)
    #expect(try await repository.note("Z.md")?.state == .synced)
    #expect(try await repository.note("A.md")?.state == .waitingToSync)
    let captureRemote = CaptureTestRemote(scope: fixture.scope)
    _ = try await captures.synchronize(with: captureRemote)
    _ = try await repository.synchronize(with: remote)
    #expect(await captureRemote.appendCount == 1)
    #expect(await remote.writes.count == 2)
    #expect(try await repository.note("A.md")?.state == .synced)
  }

  @Test(arguments: [CaptureState.sending, .applied])
  func interruptionBeforeSendOrReceiptCommitRecoversFromTheLastDurableState(
    _ failedState: CaptureState
  ) async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let directory = WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
    let sqlite = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let faults = CaptureCommitFailureStore(wrapped: sqlite, failedState: failedState)
    let outbox = CaptureOutbox(scope: fixture.scope, store: faults)
    let original = try await outbox.enqueue(
      text: "A durable task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    let remote = CaptureTestRemote(scope: fixture.scope)
    await #expect(throws: WorkspaceRepositoryError.storage("Injected transaction interruption")) {
      try await outbox.synchronize(with: remote)
    }
    #expect(await remote.appendCount == (failedState == .sending ? 0 : 1))
    let restarted = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    #expect(
      try await restarted.capture(original.id)?.state
        == (failedState == .sending ? .queued : .sending))
    _ = try await restarted.synchronize(with: remote)
    #expect(await remote.appendCount == 1)
    #expect(try await restarted.capture(original.id)?.state == .applied)
  }

  @Test func restartRetriesTheIdenticalReceiptRequestWithoutDuplicatingAnAppend() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let capture = try await outbox.enqueue(
      text: "- [ ] One task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000.12345),
      timeZone: #require(TimeZone(identifier: "America/Los_Angeles")))
    #expect(capture.operation.capturedAt == 1_700_000_000_123)
    let remote = CaptureTestRemote(scope: fixture.scope)
    await remote.loseNextResponse()
    await #expect(throws: TestNetworkError.self) { try await outbox.synchronize(with: remote) }
    #expect(try await outbox.capture(capture.id)?.state == .sending)
    let restarted = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let result = try await restarted.synchronize(with: remote)
    #expect(result.first?.state == .applied)
    #expect(result.first?.receipt?.note?.content == "- [ ] One task")
    #expect(await remote.appendCount == 1)
    let attempts = await remote.attempts
    #expect(attempts.count == 2)
    #expect(attempts.allSatisfy { $0 == capture.operation })
  }

  @Test(arguments: [
    ("2026-01-01T00:30:00Z", "America/Los_Angeles", "2025-12-31"),
    ("2026-03-08T09:59:00Z", "America/Los_Angeles", "2026-03-08"),
    ("2026-03-08T10:01:00Z", "America/Los_Angeles", "2026-03-08"),
    ("2026-12-31T23:30:00Z", "Asia/Tokyo", "2027-01-01"),
  ])
  func captureFreezesThePhoneCalendarDateAcrossMidnightTravelAndDST(
    _ input: (String, String, String)
  ) throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let time = try #require(ISO8601DateFormatter().date(from: input.0))
    let zone = try #require(TimeZone(identifier: input.1))
    let operation = try CaptureOperation(
      scope: fixture.scope, text: "A task", capturedAt: time, timeZone: zone)
    #expect(operation.localDate == input.2)
    #expect(operation.timeZone == input.1)
    #expect(operation.capturedAt == time.timeIntervalSince1970 * 1_000)
  }

  @Test func anOperationIDCannotBeReusedWithAnotherPayloadOrResurrectACancelledCapture()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let time = Date(timeIntervalSince1970: 1_700_000_000)
    let zone = try #require(TimeZone(identifier: "UTC"))
    let capture = try await outbox.enqueue(text: "Original", capturedAt: time, timeZone: zone)
    let cancelled = try await outbox.cancel(capture.id, replacing: capture.revision)
    let duplicate = try await outbox.enqueue(
      text: "Original", capturedAt: time, timeZone: zone, operationID: capture.id)
    #expect(duplicate.state == .cancelled)
    #expect(duplicate.revision == cancelled.revision)
    await #expect(throws: CaptureError.operationIDReused) {
      try await outbox.enqueue(
        text: "Different", capturedAt: time, timeZone: zone, operationID: capture.id)
    }
    let remote = CaptureTestRemote(scope: fixture.scope)
    _ = try await outbox.synchronize(with: remote)
    #expect(await remote.attempts.isEmpty)
  }

  @Test func attemptedCaptureCannotBeCancelledAndIndeterminateRequiresExplicitReconciliation()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let capture = try await outbox.enqueue(
      text: "Task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    let remote = CaptureTestRemote(scope: fixture.scope)
    await remote.makeIndeterminate()
    _ = try await outbox.synchronize(with: remote)
    let uncertain = try #require(await outbox.capture(capture.id))
    #expect(uncertain.state == .indeterminate)
    await #expect(throws: CaptureError.cannotCancelAttemptedCapture) {
      try await outbox.cancel(capture.id, replacing: uncertain.revision)
    }
    _ = try await outbox.synchronize(with: remote)
    #expect(await remote.attempts.count == 1)
    let repository = try fixture.open()
    _ = try await repository.create(path: "Other.md", content: "Other text")
    let notesRemote = RepositoryRemote(scope: fixture.scope)
    _ = try await repository.synchronize(with: notesRemote)
    #expect(try await repository.note("Other.md")?.state == .waitingToSync)
    let inspection = try await outbox.inspectIndeterminate(
      capture.id, replacing: uncertain.revision, with: notesRemote)
    #expect(inspection.note == nil)
    #expect(inspection.path == uncertain.receipt?.path)
    _ = try await outbox.markReconciled(afterReview: inspection)
    _ = try await repository.synchronize(with: notesRemote)
    #expect(await notesRemote.notes["Other.md"]?.content == "Other text")
    #expect(await remote.attempts.count == 1)
  }

  @Test func captureReviewRequiresTheSameConnectionAndUnchangedOriginalRevision() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let capture = try await outbox.enqueue(
      text: "Original task", capturedAt: Date(), timeZone: .current)
    let appendRemote = CaptureTestRemote(scope: fixture.scope)
    await appendRemote.makeIndeterminate()
    _ = try await outbox.synchronize(with: appendRemote)
    let uncertain = try #require(await outbox.capture(capture.id))
    let remote = RepositoryRemote(scope: fixture.scope)
    let path = try #require(uncertain.receipt?.path)
    await remote.replace(
      path, with: RemoteNote(content: "Current note", version: "current-version"))
    let inspection = try await outbox.inspectIndeterminate(
      capture.id, replacing: uncertain.revision, with: remote)
    #expect(inspection.note?.content == "Current note")
    await outbox.invalidateConnection()
    await #expect(throws: WorkspaceRepositoryError.connectionChanged) {
      try await outbox.markReconciled(afterReview: inspection)
    }
    await remote.setIdentity(workspaceID: "other-workspace")
    await #expect(throws: WorkspaceRepositoryError.workspaceMismatch) {
      try await outbox.inspectIndeterminate(capture.id, replacing: uncertain.revision, with: remote)
    }
    await remote.setIdentity(workspaceID: fixture.scope.workspaceID)
    let fresh = try await outbox.inspectIndeterminate(
      capture.id, replacing: uncertain.revision, with: remote)
    let second = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await second.markReconciled(capture.id, replacing: uncertain.revision)
    await #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try await outbox.markReconciled(afterReview: fresh)
    }
    #expect(await appendRemote.attempts.count == 1)
    #expect(await remote.writes.isEmpty)
    #expect(try await outbox.capture(capture.id)?.operation.text == "Original task")
  }

  @Test func captureBarrierSurvivesRestartAndNeverBecomesAFullNoteSave() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await outbox.enqueue(
      text: "Captured task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    let repository = try fixture.open()
    _ = try await repository.create(path: "Other.md", content: "Separate editor text")
    let notesRemote = RepositoryRemote(scope: fixture.scope)
    _ = try await repository.synchronize(with: notesRemote)
    #expect(try await repository.note("Other.md")?.state == .waitingToSync)
    #expect(await notesRemote.writes.isEmpty)
    #expect(try await repository.notes().map(\.content) == ["Separate editor text"])
    let restarted = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await restarted.synchronize(with: CaptureTestRemote(scope: fixture.scope))
    _ = try await repository.synchronize(with: notesRemote)
    #expect(await notesRemote.writes.first?.content == "Separate editor text")
  }

  @Test func anExistingUnacknowledgedNoteWriteCanResolveBeforeCaptureWithoutDeadlock() async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "New.md", content: "Editor text")
    let notesRemote = RepositoryRemote(scope: fixture.scope)
    await notesRemote.loseNextResponse()
    await #expect(throws: TestNetworkError.self) {
      try await repository.synchronize(with: notesRemote)
    }
    let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await outbox.enqueue(
      text: "Captured task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    let captureRemote = CaptureTestRemote(scope: fixture.scope)
    await #expect(throws: WorkspaceRepositoryError.pendingNoteWrites) {
      try await outbox.synchronize(with: captureRemote)
    }
    #expect(await captureRemote.attempts.isEmpty)
    _ = try await repository.synchronize(with: notesRemote)
    _ = try await outbox.synchronize(with: captureRemote)
    #expect(await captureRemote.appendCount == 1)
    #expect(await notesRemote.writes.count == 1)
  }

  @Test func changedHostAndMismatchedReceiptNeverAcknowledgeTheCapture() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let capture = try await outbox.enqueue(
      text: "Task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    let remote = CaptureTestRemote(scope: fixture.scope)
    await remote.changeHost(to: "another-host")
    await #expect(throws: WorkspaceRepositoryError.hostMismatch) {
      try await outbox.synchronize(with: remote)
    }
    #expect(await remote.attempts.isEmpty)
    await remote.changeHost(to: fixture.scope.hostID)
    await remote.returnWrongReceipt()
    await #expect(throws: CaptureError.receiptMismatch) {
      try await outbox.synchronize(with: remote)
    }
    #expect(try await outbox.capture(capture.id)?.state == .sending)
  }

  @Test func cacheTrimmingNeverRemovesPendingCaptureOrItsReceipt() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let capture = try await outbox.enqueue(
      text: "Task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    let cache = try WorkspaceCache(
      rootDirectory: fixture.directory, scope: fixture.scope, budgetBytes: 0)
    _ = try await cache.trim()
    #expect(try await outbox.capture(capture.id)?.state == .queued)
    _ = try await outbox.synchronize(with: CaptureTestRemote(scope: fixture.scope))
    _ = try await cache.trim()
    #expect(try await outbox.capture(capture.id)?.receipt?.outcome == .applied)
  }
}

private struct CaptureCommitFailureStore: WorkspaceStateStore {
  let wrapped: any WorkspaceStateStore
  let failedState: CaptureState
  func value(_ key: String) throws -> WorkspaceStoredValue? { try wrapped.value(key) }
  func values(prefix: String) throws -> [WorkspaceStoredValue] {
    try wrapped.values(prefix: prefix)
  }
  func valueSummaries() throws -> [WorkspaceValueSummary] { try wrapped.valueSummaries() }
  func commitValues(_ changes: [WorkspaceValueMutation]) throws -> [String: Int64] {
    for change in changes {
      if let payload = change.value?.data,
        let capture = try? JSONDecoder().decode(QueuedCapture.self, from: payload),
        capture.state == failedState
      {
        throw WorkspaceRepositoryError.storage("Injected transaction interruption")
      }
    }
    return try wrapped.commitValues(changes)
  }
}

actor CaptureTestRemote: CaptureRemote {
  nonisolated let profileID: UUID
  nonisolated let origin: ConnectionOrigin
  var identityValue: RemoteWorkspaceIdentity
  var attempts: [CaptureOperation] = []
  var receipts: [UUID: CaptureReceipt] = [:]
  var appendCount = 0
  var loseResponse = false
  var indeterminate = false
  var wrongReceipt = false

  init(scope: WorkspaceScope) {
    profileID = scope.profileID
    origin = scope.origin
    identityValue = RemoteWorkspaceIdentity(
      workspaceID: scope.workspaceID, hostID: scope.hostID,
      supportsConditionalWorkspaceWrites: true, supportsAtomicCapture: true)
  }

  func identity() -> RemoteWorkspaceIdentity { identityValue }
  func loseNextResponse() { loseResponse = true }
  func makeIndeterminate() { indeterminate = true }
  func changeHost(to hostID: String) { identityValue.hostID = hostID }
  func returnWrongReceipt() { wrongReceipt = true }

  func append(_ capture: CaptureOperation) throws -> CaptureReceipt {
    attempts.append(capture)
    if let saved = receipts[capture.id] { return saved }
    appendCount += 1
    let path = "Daily/" + capture.localDate + ".md"
    let receipt = CaptureReceipt(
      operationID: wrongReceipt ? UUID() : capture.id,
      workspaceID: capture.scope.workspaceID, hostID: capture.scope.hostID,
      hostDate: "2026-09-27", hostTimeZone: "UTC", watched: false,
      outcome: indeterminate ? .indeterminate : .applied,
      note: indeterminate
        ? nil
        : DailyNoteResponse(
          path: path, content: capture.text, version: "captured-v1",
          mtime: capture.capturedAt, date: capture.localDate, created: true),
      path: indeterminate ? path : nil)
    receipts[capture.id] = receipt
    if loseResponse {
      loseResponse = false
      throw TestNetworkError.disconnected
    }
    return receipt
  }
}
