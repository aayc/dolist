import DailyDoListAgentCore
import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct AgentMutationJournalTests {
  @Test func lostResponseSurvivesRestartAndCacheEvictionWithoutResending() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let remote = MutationRemote(scope: fixture.scope)
    let journal = try open(fixture, remote)
    let command = AgentMutationCommand.message(threadID: "thread-test", text: "Synthetic reply")
    await remote.configure(outcome: .applied)
    await #expect(throws: AgentMutationError.uncertain("message-one")) {
      try await journal.perform(command, operationID: "message-one", authorize: { true })
    }
    let cache = try WorkspaceCache(
      rootDirectory: fixture.directory, scope: fixture.scope, budgetBytes: 0)
    #expect(try await cache.trim().protectedBytes > 0)
    let reopened = try open(fixture, remote)
    #expect(try await reopened.pending().map(\.id) == ["message-one"])
    #expect(try await reopened.resolve("message-one") == .thread(ThreadActionResponse()))
    #expect(
      try await reopened.perform(command, operationID: "message-one", authorize: { true })
        == .thread(ThreadActionResponse()))
    #expect(try await reopened.pending().isEmpty)
    #expect(await remote.sent.map(\.1) == ["message-one"])
    #expect(await remote.lookups == ["message-one"])
    _ = try await cache.trim()
    #expect(try await cache.trim().protectedBytes == 0)
  }

  @Test func evictedReceiptCanReconcileSameOperationWithNonreusedRevision() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let remote = MutationRemote(scope: fixture.scope)
    await remote.configure(outcome: .applied)
    let journal = try open(fixture, remote)
    let command = AgentMutationCommand.cancelThread("thread-test")
    for _ in 0..<2 {
      await #expect(throws: AgentMutationError.uncertain("same-id")) {
        try await journal.perform(command, operationID: "same-id", authorize: { true })
      }
      #expect(try await journal.resolve("same-id") == .thread(ThreadActionResponse()))
      let cache = try WorkspaceCache(
        rootDirectory: fixture.directory, scope: fixture.scope, budgetBytes: 0)
      _ = try await cache.trim()
    }
    #expect(await remote.sent.map(\.1) == ["same-id", "same-id"])
    #expect(try await journal.pending().isEmpty)
  }

  @Test(arguments: [AgentOperationResponse.Outcome.pending, .indeterminate])
  func unknownOutcomeNeverReplaysOrChangesItsIntent(_ outcome: AgentOperationResponse.Outcome)
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let remote = MutationRemote(scope: fixture.scope)
    await remote.configure(outcome: outcome)
    let journal = try open(fixture, remote)
    await #expect(throws: AgentMutationError.uncertain("pause-one")) {
      try await journal.perform(
        .pauseRoutine("routine-test"), operationID: "pause-one", authorize: { true })
    }
    let reopened = try open(fixture, remote)
    await #expect(throws: AgentMutationError.uncertain("pause-one")) {
      try await reopened.perform(
        .pauseRoutine("routine-test"), operationID: nil, authorize: { true })
    }
    await #expect(throws: AgentMutationError.changedIntent("pause-one")) {
      try await reopened.perform(
        .resumeRoutine("routine-test"), operationID: nil, authorize: { true })
    }
    await #expect(throws: AgentMutationError.changedIntent("pause-one")) {
      try await reopened.perform(
        .cancelThread("thread-test"), operationID: "pause-one", authorize: { true })
    }
    #expect(await remote.sent.count == 1)
    #expect(try await reopened.pending().count == 1)
  }

  @Test func changedAuthorizationAfterPreparationNeverDispatches() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let remote = MutationRemote(scope: fixture.scope)
    let journal = try open(fixture, remote)
    await #expect(throws: AgentMutationError.authorizationChanged) {
      try await journal.perform(
        .retryThread("thread-test"), operationID: "retry-one", authorize: { false })
    }
    #expect(await remote.sent.isEmpty)
    #expect(try await journal.pending().isEmpty)
    await #expect(throws: AgentMutationError.authorizationChanged) {
      try await journal.resolve("retry-one")
    }
  }

  @Test(arguments: ["workspace", "host", "capability"])
  func verificationFailureDoesNotQueueAnAction(_ changed: String) async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let remote = MutationRemote(scope: fixture.scope)
    await remote.change(changed)
    let journal = try open(fixture, remote)
    await #expect(throws: (any Error).self) {
      try await journal.perform(.cancelThread("thread-test"), operationID: nil, authorize: { true })
    }
    #expect(try await journal.pending().isEmpty)
    #expect(await remote.sent.isEmpty)
  }

  @Test func twoHandlesCannotPrepareDifferentIDsForOneUnresolvedControl() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let remote = MutationRemote(scope: fixture.scope)
    let first = try open(fixture, remote)
    let second = try open(fixture, remote)
    async let one: Void = attempt(first)
    async let two: Void = attempt(second)
    _ = await (one, two)
    #expect(await remote.sent.count == 1)
    #expect(try await first.pending().count == 1)
  }

  private func attempt(_ journal: MobileAgentMutationJournal) async {
    _ = try? await journal.perform(
      .runRoutine("routine-test"), operationID: nil, authorize: { true })
  }

  private func open(_ fixture: RepositoryFixture, _ remote: MutationRemote) throws
    -> MobileAgentMutationJournal
  {
    try MobileAgentMutationJournal(
      rootDirectory: fixture.directory, scope: fixture.scope, remote: remote)
  }
}

private actor MutationRemote: AgentMutationRemote {
  var identity: HealthResponse
  var outcome: AgentOperationResponse.Outcome = .indeterminate
  var sent: [(AgentMutationCommand, String)] = []
  var lookups: [String] = []

  init(scope: WorkspaceScope) {
    identity = HealthResponse(
      version: "test", apiVersion: 1, vaultName: "Synthetic", agentMode: .mock,
      workspaceId: scope.workspaceID, hostId: scope.hostID, capabilities: ["agent-mutations-v1"])
  }
  func health() -> HealthResponse { identity }
  func configure(outcome: AgentOperationResponse.Outcome) { self.outcome = outcome }
  func change(_ part: String) {
    if part == "workspace" { identity.workspaceId = "different-workspace" }
    if part == "host" { identity.hostId = "different-host" }
    if part == "capability" { identity.capabilities = [] }
  }
  func send(_ command: AgentMutationCommand, operationID: String) throws -> AgentMutationResult {
    sent.append((command, operationID))
    throw DaemonClientError.cancelled
  }
  func receipt(_ operationID: String) -> AgentOperationResponse {
    lookups.append(operationID)
    return AgentOperationResponse(
      operationId: operationID, workspaceId: identity.workspaceId!, outcome: outcome,
      response: outcome == .applied ? .init(status: 200, body: .object(["ok": .bool(true)])) : nil)
  }
}
