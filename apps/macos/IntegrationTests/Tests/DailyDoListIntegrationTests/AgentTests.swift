import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

extension RealDaemonTests {
  /// The mock agent (`DDL_AGENT_MODE=mock`): a deterministic fake model behind the real
  /// orchestrator, subagents, safety gate and approvals. Tasks go into today's daily note, the only
  /// note the agent watches by default.
  @MainActor
  @Suite("Agent (mock mode)")
  struct Agent {
    /// A connected client, with the agent reacting quickly to edits.
    func start() async throws -> (HTTPDaemonClient, EventLog) {
      let (client, log) = try await connectedClient(try Fixtures.current())
      _ = try await client.updateSettings(SettingsPatch(agent: .init(settleMs: 300)))
      return (client, log)
    }

    /// Appends `- [ ] task` to today's daily note (created if needed); returns the note's path.
    func addTask(_ task: String, with client: HTTPDaemonClient) async throws -> String {
      let note = try await client.dailyNote("today", create: true)
      for _ in 0..<5 {
        let current = try await client.readNote(note.path)
        let body =
          current.content.isEmpty || current.content.hasSuffix("\n")
          ? current.content : current.content + "\n"
        do {
          _ = try await client.writeNote(
            note.path, content: body + "- [ ] \(task)\n", baseVersion: .match(current.version))
          return note.path
        } catch DaemonClientError.conflict {
          continue
        }
      }
      throw FixtureError("couldn't append “\(task)” to \(note.path)")
    }

    /// Waits for the task's pending approval.
    func pendingApproval(for record: TaskAgentRecord, in log: EventLog, from: Int) async throws
      -> ApprovalRequest
    {
      try await log.event(from: from, "a pending approval for “\(record.text)”") {
        event -> ApprovalRequest? in
        guard case .approvalUpsert(let approval) = event, approval.taskId == record.taskId,
          approval.status == .pending
        else { return nil }
        return approval
      }
    }

    @Test func theAgentRunsInMockMode() async throws {
      let (client, _) = try await start()

      let status = try await client.agentStatus()

      #expect(status.mode == .mock)
      #expect(status.enabled)
      #expect(status.problem == nil)
      await client.disconnect()
    }

    @Test func aNewTaskGetsAStreamedThreadAndAnArtifact() async throws {
      let (client, log) = try await start()
      let task = "Research the best standing desks \(unique())"
      let mark = log.mark

      let notePath = try await addTask(task, with: client)

      let record = try await log.record(from: mark, text: task)
      #expect(record.notePath == notePath)
      let thread = try await log.event(from: mark, "thread.upsert for the task") {
        event -> ThreadSummary? in
        if case .threadUpsert(let thread) = event, thread.taskId == record.taskId { return thread }
        return nil
      }
      #expect(thread.title == task)
      _ = try await log.event(from: mark, "thread.message") { event -> ThreadMessageEvent? in
        if case .threadMessage(let message) = event, message.threadId == thread.id {
          return message
        }
        return nil
      }
      _ = try await log.event(from: mark, "thread.delta (streamed text)") {
        event -> ThreadDeltaEvent? in
        if case .threadDelta(let delta) = event, delta.threadId == thread.id { return delta }
        return nil
      }
      let done = try await log.record(from: mark, text: task, status: .done)
      #expect(done.threadId == thread.id)

      #expect(
        try await client.taskRecords(notePath: notePath).contains {
          $0.taskId == done.taskId && $0.status == .done
        })
      #expect(
        try await client.threads(notePath: notePath, taskId: nil).contains { $0.id == thread.id })
      let full = try await client.thread(thread.id)
      #expect(full.thread.status == .done)
      let artifact = try #require(
        full.thread.artifacts.first, "the subagent hands back an artifact")
      let payload = try await client.artifact(threadId: thread.id, artifactId: artifact.id)
      #expect(payload.mimeType == "text/markdown")
      #expect(String(decoding: payload.data, as: UTF8.self).contains("# \(task)"))
      await client.disconnect()
    }

    @Test func anOrderWaitsForApprovalAndCompletesOnceApproved() async throws {
      let (client, log) = try await start()
      let task = "Order a replacement water filter \(unique())"
      let mark = log.mark

      _ = try await addTask(task, with: client)
      let record = try await log.record(from: mark, text: task)
      let approval = try await pendingApproval(for: record, in: log, from: mark)
      _ = try await log.record(from: mark, text: task, status: .waitingApproval)

      #expect(approval.toolName == "mock_irreversible_action")
      #expect(approval.categories.contains(.payment))
      #expect(approval.summary.contains("Mock order"))
      #expect(try await client.approvals(status: .pending).contains { $0.id == approval.id })

      let decided = try await client.decideApproval(
        approval.id, ApprovalDecisionRequest(decision: .approve, scope: .once))
      #expect(decided.status == .approved)
      #expect(decided.scope == .once)
      let twice = await captureError {
        try await client.decideApproval(approval.id, ApprovalDecisionRequest(decision: .deny))
      }
      guard case .approvalConflict(let conflict)? = twice else {
        Issue.record("deciding twice should conflict, got \(String(describing: twice))")
        return
      }
      #expect(conflict.approval.status == .approved)

      let done = try await log.record(from: mark, text: task, status: .done)
      #expect(done.summary?.contains("Ordered") == true)
      await client.disconnect()
    }

    @Test func aDeniedBookingNeedsTheUserAndRetryRespectsTheDenial() async throws {
      let (client, log) = try await start()
      let task = "Book a table for two on Friday \(unique())"
      let mark = log.mark

      _ = try await addTask(task, with: client)
      let record = try await log.record(from: mark, text: task)
      let approval = try await pendingApproval(for: record, in: log, from: mark)
      let denied = try await client.decideApproval(
        approval.id, ApprovalDecisionRequest(decision: .deny, note: "Friday is fully booked for me")
      )

      #expect(denied.status == .denied)
      #expect(denied.decisionNote == "Friday is fully booked for me")
      let waiting = try await log.record(from: mark, text: task, status: .waitingUser)
      let threadId = try #require(waiting.threadId)
      let thread = try await client.thread(threadId)
      #expect(
        thread.thread.messages.contains { message in
          if case .toolCall(let call) = message { return call.status == .blocked }
          return false
        }, "the gate blocked the booking")
      #expect(thread.texts.contains { $0.contains("Friday is fully booked for me") })

      let retryMark = log.mark
      let retried = try await client.retryThread(threadId)
      #expect(retried.ok)
      _ = try await log.record(from: retryMark, text: task, status: .working)
      _ = try await log.record(from: retryMark, text: task, status: .waitingUser)
      let after = try await client.thread(threadId)
      #expect(
        after.texts.contains { $0.contains("denied it earlier") },
        "the retry doesn't book behind the user's back")
      await client.disconnect()
    }

    @Test func cancellingAThreadCancelsItsPendingApproval() async throws {
      let (client, log) = try await start()
      let task = "Buy a new phone case \(unique())"
      let mark = log.mark

      _ = try await addTask(task, with: client)
      let record = try await log.record(from: mark, text: task)
      let approval = try await pendingApproval(for: record, in: log, from: mark)
      let waiting = try await log.record(from: mark, text: task, status: .waitingApproval)
      let threadId = try #require(waiting.threadId)
      let cancelMark = log.mark

      let cancelled = try await client.cancelThread(threadId)

      #expect(cancelled.ok)
      _ = try await log.record(from: cancelMark, text: task, status: .cancelled)
      _ = try await log.event(from: cancelMark, "the approval is cancelled") {
        event -> ApprovalRequest? in
        guard case .approvalUpsert(let update) = event, update.id == approval.id,
          update.status == .cancelled
        else { return nil }
        return update
      }
      #expect(try await !client.approvals(status: .pending).contains { $0.id == approval.id })
      let late = await captureError {
        try await client.decideApproval(approval.id, ApprovalDecisionRequest(decision: .approve))
      }
      #expect(late?.httpStatus == 409, "a cancelled approval can't be approved")
      await client.disconnect()
    }
  }
}
