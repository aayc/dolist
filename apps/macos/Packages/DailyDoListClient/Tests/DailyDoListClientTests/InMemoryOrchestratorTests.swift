import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// The orchestrator's chat of `InMemoryDaemonClient`, like the daemon's.
struct InMemoryOrchestratorTests {
  static let today = InMemoryAgentTests.today

  private static func texts(_ thread: AgentThread) -> [String] {
    thread.messages.map { message in
      switch message {
      case .text(let text): "\(text.author): \(text.text)"
      case .status(let status): "[\(status.status.rawValue)] \(status.text ?? "")"
      case .toolCall(let call): "\(call.toolName) \(call.status.rawValue)"
      default: message.kind
      }
    }
  }

  @Test func existsWhileTheAgentRunsAndRecordsEachDecision() async throws {
    let client = InMemoryAgentTests.client()
    let empty = try await client.thread(OrchestratorThread.id).thread
    #expect(empty.taskId == nil && empty.notePath == nil && empty.status == .idle)
    #expect(empty.title == "Orchestrator" && empty.messages.isEmpty)

    _ = try await client.writeNote(
      Self.today, content: "- [ ] Research standing desks\n", baseVersion: .createOnly)
    let record = try #require(try await client.taskRecords(notePath: Self.today).first)
    let thread = try await client.thread(OrchestratorThread.id).thread
    #expect(
      Self.texts(thread) == [
        "[working] \(Self.today) changed: 1 task", "spawn_subagent ok",
        "[working] “Research standing desks” finished",
      ])
    guard case .toolCall(let spawn) = thread.messages[1] else {
      Issue.record("expected the spawn")
      return
    }
    #expect(spawn.input["taskId"] == .string(record.taskId))
    #expect(thread.status == .idle)
    #expect(
      try await client.threads(notePath: Self.today, taskId: nil).allSatisfy { $0.taskId != nil })
  }

  @Test func answersTheUserWithAStreamedReply() async throws {
    let client = InMemoryAgentTests.client()
    _ = try await client.writeNote(
      Self.today, content: "- [ ] Research standing desks\n", baseVersion: .createOnly)
    var deltas = 0
    var statuses: [TaskAgentStatus] = []
    let items = try await InMemoryAgentTests.collect(client) {
      _ = try await client.postMessage(
        threadId: OrchestratorThread.id, text: "What are you working on?")
    }
    for event in InMemoryAgentTests.events(items) {
      switch event {
      case .threadDelta(let delta) where delta.threadId == OrchestratorThread.id: deltas += 1
      case .threadUpsert(let summary) where summary.isOrchestrator: statuses.append(summary.status)
      default: break
      }
    }
    #expect(deltas > 3)
    #expect(InMemoryAgentTests.transitions(statuses) == [.idle, .working, .idle])
    let thread = try await client.thread(OrchestratorThread.id).thread
    #expect(
      Array(Self.texts(thread).suffix(3)) == [
        "you: What are you working on?", "[working] You wrote to me",
        "orchestrator: Nothing is running right now. Done today: 1.",
      ])
  }

  @Test func stopEndsTheReplyInProgress() async throws {
    let client = InMemoryAgentTests.client(.manual())
    _ = try await client.postMessage(threadId: OrchestratorThread.id, text: "Tell me a story")
    await client.advance(by: .milliseconds(1_300))
    #expect(try await client.thread(OrchestratorThread.id).thread.status == .working)
    _ = try await client.cancelThread(OrchestratorThread.id)
    await client.advance(by: .milliseconds(5_000))
    let thread = try await client.thread(OrchestratorThread.id).thread
    #expect(thread.status == .idle)
    #expect(Self.texts(thread).last == "[cancelled] You stopped this run")
    #expect(
      !thread.messages.contains {
        if case .text(let text) = $0 { text.streaming == true } else { false }
      })
  }

  @Test func aDaemonWhoseAgentIsOffHasNone() async throws {
    let client = InMemoryDaemonClient(seed: .demo, clock: .immediate(), agent: .disabled)
    await #expect(throws: DaemonClientError.self) {
      _ = try await client.thread(OrchestratorThread.id)
    }
  }
}
