import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// What the simulated orchestrator reports while the user writes (`orchestrator.activity`).
struct InMemoryActivityTests {
  static let today = InMemoryAgentTests.today
  static let start = InMemoryAgentTests.start

  static func activities(_ events: [ServerEvent]) -> [OrchestratorActivity] {
    events.compactMap { if case .orchestratorActivity(let activity) = $0 { activity } else { nil } }
  }

  static func statusLine(_ id: String?, in thread: AgentThread) -> String? {
    thread.messages.lazy.compactMap { message -> String? in
      guard case .status(let status) = message, status.id == id else { return nil }
      return status.text
    }.first
  }

  @Test func aRequestIsNoticedAtOnceThenReadThoughtAboutAndTurnedIntoATask() async throws {
    let client = InMemoryAgentTests.client(.manual())
    let recorder = StreamRecorder(client.events())
    await client.connect()
    _ = try await client.writeNote(
      Self.today, content: "Groceries are done\nfind a quiet dishwasher\n",
      baseVersion: .createOnly)
    try await recorder.waitFor("noticed") {
      if case .event(.orchestratorActivity) = $0 { true } else { false }
    }
    let noticed = try #require(Self.activities(recorder.events).first)
    #expect(noticed.phase == .noticed && noticed.turnId == nil && noticed.outcome == nil)
    #expect(
      noticed.trigger
        == OrchestratorTrigger(
          kind: .note, notePath: Self.today,
          lines: [OrchestratorTriggerLine(line: 1, text: "find a quiet dishwasher")],
          summary: "“find a quiet dishwasher”"))
    #expect(try await client.agentStatus().orchestrator == nil, "noticing isn't a turn yet")

    // It wakes once the settle delay passed.
    await client.advance(by: .milliseconds(1_199))
    #expect(try await client.agentStatus().orchestrator == nil)
    await client.advance(by: .milliseconds(1))
    try await waitUntil("reading") { Self.activities(recorder.events).count == 2 }
    let reading = Self.activities(recorder.events)[1]
    #expect(reading.phase == .reading)
    #expect(reading.startedAt == Self.start + 1_200)
    #expect(reading.trigger == noticed.trigger)
    #expect(try await client.agentStatus().orchestrator == reading, "a client joining now sees it")
    let chat = try await client.thread(OrchestratorThread.id).thread
    #expect(Self.statusLine(reading.turnId, in: chat) == "\(Self.today) changed: 1 line")

    await client.advance(by: .milliseconds(600))
    await client.advance(by: .milliseconds(1_200))
    await client.advance(by: .milliseconds(500))
    try await waitUntil("the outcome") { Self.activities(recorder.events).count == 5 }
    let turn = Self.activities(recorder.events).dropFirst()
    #expect(turn.map(\.phase) == [.reading, .thinking, .acting, .idle])
    #expect(Set(turn.map(\.turnId)) == [reading.turnId])
    #expect(Set(turn.map(\.startedAt)) == [reading.startedAt])
    #expect(
      turn.last?.outcome
        == OrchestratorOutcome(
          kind: .tasksAdded, count: 1, text: "Added “Find a quiet dishwasher” to your list"))
    #expect(try await client.agentStatus().orchestrator == nil)

    let note = try await client.readNote(Self.today).content
    #expect(
      note.hasPrefix(
        "Groceries are done\nfind a quiet dishwasher\n"
          + "- [ ] Find a quiet dishwasher %%agent:\(OrchestratorThread.id)%%\n"))
    let texts = try await client.thread(OrchestratorThread.id).thread.messages.map { message in
      switch message {
      case .status(let status): "[\(status.status.rawValue)] \(status.text ?? "")"
      case .toolCall(let call): "\(call.toolName) \(call.status.rawValue)"
      default: message.kind
      }
    }
    #expect(Array(texts.prefix(2)) == ["[working] \(Self.today) changed: 1 line", "edit_note ok"])
    await client.disconnect()
  }

  @Test func aQuestionIsAnsweredInTheChat() async throws {
    let client = InMemoryAgentTests.client()
    let items = try await InMemoryAgentTests.collect(client) {
      _ = try await client.writeNote(
        Self.today, content: "How tall is Ridge Tower?\n", baseVersion: .createOnly)
    }
    let activities = Self.activities(InMemoryAgentTests.events(items))
    #expect(activities.map(\.phase) == [.noticed, .reading, .thinking, .idle])
    #expect(
      activities.last?.outcome
        == OrchestratorOutcome(kind: .replied, text: "Answered in the orchestrator chat"))
    let chat = try await client.thread(OrchestratorThread.id).thread
    guard case .text(let answer) = chat.messages.last else {
      Issue.record("expected the answer last")
      return
    }
    #expect(answer.text.hasPrefix("You asked “How tall is Ridge Tower?”"))
    #expect(try await client.readNote(Self.today).content == "How tall is Ridge Tower?\n")
  }

  @Test func plainProseAndTheSeedWakeNothing() async throws {
    let client = InMemoryAgentTests.client(seed: .demo)
    let items = try await InMemoryAgentTests.collect(client) {
      let daily = try await client.dailyNote("today", create: true)
      _ = try await client.writeNote(
        daily.path, content: daily.content + "\nHad a long walk by the river\n",
        baseVersion: .match(daily.version))
    }
    #expect(Self.activities(InMemoryAgentTests.events(items)).isEmpty)
  }

  @Test func typingUpdatesTheNoticedLineAndDeletingItStandsDown() async throws {
    let client = InMemoryAgentTests.client(.manual())
    let recorder = StreamRecorder(client.events())
    await client.connect()
    var version = try await client.writeNote(
      Self.today, content: "find a la\n", baseVersion: .createOnly
    ).version
    await client.advance(by: .milliseconds(500))
    version = try await client.writeNote(
      Self.today, content: "find a lamp\n", baseVersion: .match(version)
    ).version
    await client.advance(by: .milliseconds(500))
    _ = try await client.writeNote(Self.today, content: "\n", baseVersion: .match(version))
    await client.advance(by: .milliseconds(5_000))
    try await waitUntil("three events") { Self.activities(recorder.events).count == 3 }
    let activities = Self.activities(recorder.events)
    #expect(activities.map(\.phase) == [.noticed, .noticed, .idle])
    #expect(
      activities.map { $0.trigger?.lines?.map(\.text) } == [
        ["find a la"], ["find a lamp"], ["find a lamp"],
      ])
    #expect(activities.last?.outcome == nil)
    #expect(try await client.thread(OrchestratorThread.id).thread.messages.isEmpty)
    await client.disconnect()
  }

  @Test func aMessageInTheChatIsATurnToo() async throws {
    let client = InMemoryAgentTests.client()
    let items = try await InMemoryAgentTests.collect(client) {
      _ = try await client.postMessage(threadId: OrchestratorThread.id, text: "What's running?")
    }
    let activities = Self.activities(InMemoryAgentTests.events(items))
    #expect(activities.map(\.phase) == [.reading, .thinking, .idle])
    #expect(
      activities.allSatisfy {
        $0.trigger == OrchestratorTrigger(kind: .message, summary: "your message")
      })
    #expect(activities.last?.outcome == OrchestratorOutcome(kind: .replied))
    let chat = try await client.thread(OrchestratorThread.id).thread
    #expect(Self.statusLine(activities.first?.turnId, in: chat) == "You wrote to me")
  }

  @Test func stoppingATurnEndsItsActivity() async throws {
    let client = InMemoryAgentTests.client(.manual())
    let recorder = StreamRecorder(client.events())
    await client.connect()
    _ = try await client.writeNote(
      Self.today, content: "research quiet dishwashers\n", baseVersion: .createOnly)
    await client.advance(by: .milliseconds(2_000))
    _ = try await client.cancelThread(OrchestratorThread.id)
    await client.advance(by: .milliseconds(5_000))
    try await waitUntil("idle") { Self.activities(recorder.events).last?.phase == .idle }
    let activities = Self.activities(recorder.events)
    #expect(activities.map(\.phase) == [.noticed, .reading, .thinking, .idle])
    #expect(activities.last?.outcome == nil)
    #expect(try await client.agentStatus().orchestrator == nil)
    #expect(try await client.readNote(Self.today).content == "research quiet dishwashers\n")
    await client.disconnect()
  }

  /// Everything it reports round-trips through the Swift models, and conforms exactly to the
  /// generated contract schema once that declares the event (the wire lands with the daemon's
  /// side, `feat/orchestrator-activity`).
  @Test func whatItReportsConformsToTheContract() async throws {
    let schema = try WireSchema.load()
    let client = InMemoryAgentTests.client(.manual())
    let recorder = StreamRecorder(client.events())
    await client.connect()
    _ = try await client.writeNote(
      Self.today, content: "find a lamp\nWhat's a good desk height?\n", baseVersion: .createOnly)
    await client.advance(by: .milliseconds(1_900))
    let midTurn = try await client.agentStatus()
    #expect(midTurn.orchestrator?.phase == .thinking)
    await client.advance(by: .milliseconds(10_000))
    _ = try await client.postMessage(threadId: OrchestratorThread.id, text: "Thanks")
    await client.advance(by: .milliseconds(10_000))
    await client.disconnect()
    try await recorder.waitForFinish()
    let events = recorder.events.filter { $0.type == "orchestrator.activity" }
    #expect(
      Set(Self.activities(events).map(\.phase)) == [.noticed, .reading, .thinking, .acting, .idle])
    for event in events {
      #expect(
        try JSONDecoder.daemon.decode(ServerEvent.self, from: JSONEncoder.daemon.encode(event))
          == event)
    }
    if schema.declaresEvent("orchestrator.activity") {
      for event in events {
        let issues = schema.validate(event, as: "ServerEvent")
        #expect(issues.isEmpty, "\(issues)")
      }
    }
    if schema.properties(of: "AgentStatusResponse").contains("orchestrator") {
      let issues = schema.validate(midTurn, as: "AgentStatusResponse")
      #expect(issues.isEmpty, "\(issues)")
    }
  }

  @Test func noticingFollowsThePrototypesRequestHeuristic() {
    for line in [
      "find a quiet dishwasher", "- look up flights to Lisbon", "Can you book a table?",
      "remind me to call Sam", "@agent compare these", "Every morning brief me on the weather",
      "What's the weather?", "## Plan the offsite",
    ] {
      #expect(FakeProse.mayBeRequest(line), "\(line)")
    }
    for line in ["Had a long walk", "Groceries are done", "ok", "Browse for a quiet dishwasher"] {
      #expect(!FakeProse.mayBeRequest(line), "\(line)")
    }
  }
}
