import DailyDoListModels
import Testing

@testable import DailyDoListAgent

/// Random event streams over a small universe of ids (so events keep hitting the same entities),
/// with few distinct timestamps (so collisions and reordering are common). Port of the web
/// reducer's fuzz test.
@Suite("Reducer: random event streams")
struct ReducerFuzzTests {
  static let notes = ["Daily/2026-09-23.md", "Daily/2026-09-22.md", "Projects/Garden.md"]
  static let tasks = ["tsk_a", "tsk_b", "tsk_c", "tsk_d"]
  static let threadIds = ["thr_a", "thr_b", "thr_c"]
  static let approvalIds = ["apr_a", "apr_b", "apr_c"]
  static let statuses: [TaskAgentStatus] = [
    .idle, .triaging, .queued, .working, .waitingApproval, .waitingUser, .done, .failed, .cancelled,
    .ignored, "future_status",
  ]

  struct Generator {
    var rng: SplitMix64

    mutating func pick<T>(_ items: [T]) -> T { items[Int.random(in: 0..<items.count, using: &rng)] }
    mutating func time() -> EpochMillis { EpochMillis(Int.random(in: 1...12, using: &rng)) }
    mutating func bool() -> Bool { Bool.random(using: &rng) }
    mutating func messageId(_ thread: String) -> String { "msg_\(thread)_\(Int.random(in: 0...3, using: &rng))" }

    mutating func record(note: String? = nil) -> TaskAgentRecord {
      TaskAgentRecord(
        taskId: pick(ReducerFuzzTests.tasks), notePath: note ?? pick(ReducerFuzzTests.notes),
        date: "2026-09-23", text: pick(["Buy milk", "Book a table"]), line: Int.random(in: 0...20, using: &rng),
        status: pick(ReducerFuzzTests.statuses), threadId: bool() ? pick(ReducerFuzzTests.threadIds) : nil,
        updatedAt: time(), unread: Int.random(in: 0...5, using: &rng))
    }

    mutating func snapshot() -> (String, [TaskAgentRecord]) {
      let note = pick(ReducerFuzzTests.notes)
      var records: [TaskAgentRecord] = []
      for _ in 0..<Int.random(in: 0...4, using: &rng) {
        let record = record(note: note)
        if !records.contains(where: { $0.taskId == record.taskId }) { records.append(record) }
      }
      return (note, records)
    }

    mutating func summary(_ id: String? = nil) -> ThreadSummary {
      ThreadSummary(
        id: id ?? pick(ReducerFuzzTests.threadIds), taskId: bool() ? pick(ReducerFuzzTests.tasks) : nil,
        notePath: bool() ? pick(ReducerFuzzTests.notes) : nil, title: pick(["Buy milk", "Buy oat milk"]),
        status: pick(ReducerFuzzTests.statuses), createdAt: 1, updatedAt: time(),
        messageCount: Int.random(in: 0...4, using: &rng), artifactCount: 0,
        surfaces: bool() ? [.browser] : [], pendingApprovals: Int.random(in: 0...2, using: &rng))
    }

    mutating func message(_ thread: String) -> ThreadMessage {
      let id = messageId(thread)
      switch Int.random(in: 0...5, using: &rng) {
      case 0, 1, 2:
        return .text(
          TextMessage(
            id: id, author: pick(["orchestrator", "you", "subagent:research"]), createdAt: time(),
            role: pick([.agent, .user]), text: pick(["", "Looking", "Looking for options…"]),
            streaming: bool()))
      case 3:
        return .toolCall(
          ToolCallMessage(
            id: id, author: "subagent:research", createdAt: 1, toolCallId: "call_\(id)",
            toolName: "web_search", input: ["query": "x"], status: pick([.running, .ok, .error])))
      case 4:
        return .status(StatusMessage(id: id, author: "system", createdAt: 1, status: pick(ReducerFuzzTests.statuses)))
      default:
        return .approval(ApprovalMessage(id: id, author: "system", createdAt: 1, approvalId: pick(ReducerFuzzTests.approvalIds)))
      }
    }

    mutating func approval() -> ApprovalRequest {
      ApprovalRequest(
        id: pick(ReducerFuzzTests.approvalIds), threadId: bool() ? pick(ReducerFuzzTests.threadIds + ["thr_zz"]) : nil,
        taskId: nil, toolName: "browser_click", input: ["element": "Place order"], summary: "Place order",
        risk: pick([.low, .high]), categories: [.payment], reason: "Spends money",
        status: pick([.pending, .approved, .denied, .expired]), createdAt: time())
    }

    mutating func loadedThread(_ id: String? = nil) -> AgentThread {
      let id = id ?? pick(ReducerFuzzTests.threadIds)
      var messages: [ThreadMessage] = []
      for _ in 0..<Int.random(in: 0...4, using: &rng) {
        let message = message(id)
        if !messages.contains(where: { $0.id == message.id }) { messages.append(message) }
      }
      return AgentThread(
        id: id, taskId: bool() ? pick(ReducerFuzzTests.tasks) : nil, notePath: pick(ReducerFuzzTests.notes),
        title: pick(["Buy milk", "Buy oat milk"]), status: pick(ReducerFuzzTests.statuses), createdAt: 1,
        updatedAt: time(), messages: messages, surfaces: bool() ? [.computer] : [])
    }

    /// Any agent event (weights roughly like the web fuzz test).
    mutating func event() -> ServerEvent {
      switch Int.random(in: 0..<20, using: &rng) {
      case 0..<4: return .taskRecord(record())
      case 4:
        let (note, records) = snapshot()
        return .taskRecords(TaskRecordsEvent(notePath: note, records: records))
      case 5..<8: return .threadUpsert(summary())
      case 8..<12:
        let thread = pick(ReducerFuzzTests.threadIds + ["thr_unknown"])
        return .threadMessage(ThreadMessageEvent(threadId: thread, message: message(thread)))
      case 12..<17:
        let thread = pick(ReducerFuzzTests.threadIds + ["thr_unknown"])
        return .threadDelta(
          ThreadDeltaEvent(threadId: thread, messageId: bool() ? messageId(thread) : "msg_unknown", delta: pick([" more", "…", "😀"])))
      case 17, 18: return .approvalUpsert(approval())
      default: return .agentStatus(Fixture.status(enabled: bool(), running: Int.random(in: 0...3, using: &rng)))
      }
    }

    /// One step: an event, a replay, or a REST snapshot.
    mutating func step(_ state: inout AgentState, history: inout [ServerEvent]) -> ServerEvent? {
      switch Int.random(in: 0..<20, using: &rng) {
      case 0..<14:
        let event = event()
        _ = state.apply(event, now: 99)
        history.append(event)
        return event
      case 14, 15:
        guard !history.isEmpty else { return nil }
        let event = pick(history)
        _ = state.apply(event, now: 99)
        return event
      case 16:
        let thread = loadedThread()
        var approvals: [ApprovalRequest] = []
        for _ in 0..<Int.random(in: 0...2, using: &rng) { approvals.append(approval()) }
        _ = state.applyThreadResponse(ThreadResponse(thread: thread, approvals: approvals))
      case 17:
        var list: [ThreadSummary] = []
        for id in ReducerFuzzTests.threadIds where bool() { list.append(summary(id)) }
        _ = state.applyThreadList(list, notePath: bool() ? nil : pick(ReducerFuzzTests.notes))
      case 18:
        var list: [ApprovalRequest] = []
        for _ in 0..<Int.random(in: 0...3, using: &rng) { list.append(approval()) }
        _ = state.applyPendingApprovals(list)
      default:
        let (note, records) = snapshot()
        _ = state.applyRecordsSnapshot(notePath: note, records: records)
      }
      return nil
    }
  }

  /// Invariants that hold after every step, whatever was delivered in whatever order.
  static func expectConsistent(_ state: AgentState, sourceLocation: SourceLocation = #_sourceLocation) {
    var notesOfTask: [String: [String]] = [:]
    for (note, records) in state.recordsByNote {
      #expect(Set(records.map(\.taskId)).count == records.count, "tasks are unique within \(note)", sourceLocation: sourceLocation)
      for record in records {
        #expect(record.notePath == note, "record stored under its note", sourceLocation: sourceLocation)
        notesOfTask[record.taskId, default: []].append(note)
      }
    }
    for (task, notes) in notesOfTask {
      #expect(notes.count == 1, "task \(task) lives in one note (\(notes))", sourceLocation: sourceLocation)
    }
    for (id, summary) in state.threads { #expect(summary.id == id, sourceLocation: sourceLocation) }
    for (id, thread) in state.loadedThreads {
      #expect(thread.id == id, sourceLocation: sourceLocation)
      let ids = thread.messages.map(\.id)
      #expect(Set(ids).count == ids.count, "messages of \(id) are unique", sourceLocation: sourceLocation)
    }
    for (id, approval) in state.approvals { #expect(approval.id == id, sourceLocation: sourceLocation) }
    for key in state.deltaPlaceholders {
      let message = state.loadedThreads[key.threadId]?.messages.first { $0.id == key.messageId }
      #expect(message?.kind == "text", "placeholders point at text messages", sourceLocation: sourceLocation)
    }
  }

  @Test(arguments: 0..<24)
  func neverBreaksInvariantsAndEveryStepDoesWhatItSays(seed: Int) {
    var generator = Generator(rng: SplitMix64(seed: UInt64(seed) &* 7919 &+ 1))
    var state = AgentState()
    var history: [ServerEvent] = []
    for _ in 0..<80 {
      let before = state
      let event = generator.step(&state, history: &history)
      Self.expectConsistent(state)
      guard let event else { continue }
      switch event {
      case .taskRecord(let record):
        let previous = before.record(forTaskId: record.taskId)
        let current = state.record(forTaskId: record.taskId)
        #expect(current != nil, "a task.record is never dropped")
        if let previous, let current { #expect(current.updatedAt >= previous.updatedAt, "a stale record never wins") }
      case .threadMessage(let e):
        if before.loadedThreads[e.threadId] == nil {
          #expect(state == before, "messages for threads that aren't loaded are ignored")
        } else {
          #expect(state.loadedThreads[e.threadId]?.messages.contains { $0.id == e.message.id } == true)
        }
      case .approvalUpsert(let approval):
        if let existing = before.approvals[approval.id], !existing.isPending, approval.isPending {
          #expect(state.approvals[approval.id] == existing, "a decision is never undone")
        } else {
          #expect(state.approvals[approval.id] == approval)
        }
      case .threadUpsert(let summary):
        if state.threads[summary.id] == summary, let thread = state.loadedThreads[summary.id] {
          #expect(thread.status == summary.status && thread.title == summary.title, "loaded thread follows its summary")
        }
      default:
        break
      }
    }
  }

  @Test(arguments: 0..<24)
  func deliveringAnEventTwiceIsTheSameAsOnce(seed: Int) {
    var generator = Generator(rng: SplitMix64(seed: UInt64(seed) &+ 1_000))
    var state = AgentState()
    var history: [ServerEvent] = []
    for _ in 0..<Int.random(in: 0...40, using: &generator.rng) { _ = generator.step(&state, history: &history) }
    for _ in 0..<10 {
      let event = generator.event()
      // Deltas carry no offset, so they're the one event that isn't idempotent.
      if case .threadDelta = event { continue }
      var once = state
      _ = once.apply(event, now: 99)
      var twice = once
      #expect(twice.apply(event, now: 99).isEmpty)
      _ = twice.apply(event, now: 99)
      #expect(twice == once)
    }
  }

  @Test(arguments: 0..<24)
  func aResyncConvergesToTheDaemonsSnapshot(seed: Int) {
    var generator = Generator(rng: SplitMix64(seed: UInt64(seed) &+ 5_000))
    var state = AgentState()
    var history: [ServerEvent] = []
    for _ in 0..<Int.random(in: 0...40, using: &generator.rng) { _ = generator.step(&state, history: &history) }

    // The daemon's consistent state: some loaded threads, their summaries, pending approvals.
    var loaded: [AgentThread] = []
    for id in Self.threadIds where generator.bool() { loaded.append(generator.loadedThread(id)) }
    let summaries = loaded.map { AgentState.summarize($0, pendingApprovals: 0) }
    var pending: [ApprovalRequest] = []
    for id in Self.approvalIds where generator.bool() {
      var approval = generator.approval()
      approval.id = id
      approval.status = .pending
      pending.append(approval)
    }
    let (note, records) = generator.snapshot()

    _ = state.applyThreadList(summaries, notePath: nil)
    _ = state.applyPendingApprovals(pending)
    _ = state.applyRecordsSnapshot(notePath: note, records: records)
    for thread in loaded { _ = state.applyThreadResponse(ThreadResponse(thread: thread, approvals: [])) }

    Self.expectConsistent(state)
    #expect(Set(state.threads.keys) == Set(summaries.map(\.id)))
    for thread in loaded { #expect(state.loadedThreads[thread.id] == thread) }
    for summary in summaries { #expect(state.threads[summary.id] == summary) }
    for approval in pending where state.approvals[approval.id]?.isPending == true {
      #expect(state.approvals[approval.id] == approval)
    }
    #expect(Set(state.pendingApprovals.map(\.id)).isSubset(of: Set(pending.map(\.id))))
  }
}
