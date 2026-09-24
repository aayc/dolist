import DailyDoListModels
import Foundation
import ImageIO
import Testing

@testable import DailyDoListClient

/// The simulated agent of `InMemoryDaemonClient`.
struct InMemoryAgentTests {
  static let today = "Daily/2026-09-23.md"
  static let start: EpochMillis = 1_790_155_800_000

  static func client(
    _ clock: SimulationClock = .immediate(), seed: InMemoryDaemonClient.Seed = .empty
  ) -> InMemoryDaemonClient {
    InMemoryDaemonClient(seed: seed, clock: clock, clientId: "macos_test")
  }

  /// Every stream item produced while `body` runs (connect → body → disconnect).
  static func collect(_ client: InMemoryDaemonClient, _ body: () async throws -> Void) async throws
    -> [DaemonStreamItem]
  {
    let recorder = StreamRecorder(client.events())
    await client.connect()
    try await body()
    await client.disconnect()
    try await recorder.waitForFinish()
    return recorder.items
  }

  static func events(_ items: [DaemonStreamItem]) -> [ServerEvent] {
    items.compactMap { if case .event(let event) = $0 { event } else { nil } }
  }

  static func records(_ events: [ServerEvent]) -> [TaskAgentRecord] {
    events.compactMap { if case .taskRecord(let record) = $0 { record } else { nil } }
  }

  /// Consecutive duplicates removed.
  static func transitions<T: Equatable>(_ values: [T]) -> [T] {
    values.reduce(into: []) { if $0.last != $1 { $0.append($1) } }
  }

  // MARK: - Flows

  @Test func researchTaskRunsToDone() async throws {
    let client = Self.client()
    let items = try await Self.collect(client) {
      _ = try await client.writeNote(
        Self.today, content: "- [ ] Research the best indoor herb garden kits\n",
        baseVersion: .createOnly)
    }
    let events = Self.events(items)
    let records = Self.records(events)
    #expect(Self.transitions(records.map(\.status)) == [.idle, .triaging, .working, .done])
    #expect(
      Self.transitions(records.compactMap(\.summary)) == [
        "Reading the task…", "Researching…", "3 options",
      ])
    let final = try #require(records.last)
    #expect(
      final.notePath == Self.today && final.date == "2026-09-23" && final.line == 0
        && final.unread == 3)
    #expect(final.text == "Research the best indoor herb garden kits")
    #expect(
      records.first?.updatedAt == Self.start + 1200, "starts once the 1.2 s settle delay passed")
    #expect(zip(records, records.dropFirst()).allSatisfy { $0.updatedAt <= $1.updatedAt })

    // The first event is the write's own echo; records snapshots bracket the new record.
    #expect(events.first?.type == "hello")
    #expect(events.dropFirst().first?.type == "vault.changed")
    #expect(
      events.contains {
        if case .taskRecords(let e) = $0 {
          e.records.map(\.taskId) == [final.taskId]
        } else {
          false
        }
      })

    let threadId = try #require(final.threadId)
    let response = try await client.thread(threadId)
    #expect(
      response.thread.status == .done && response.thread.title == final.text
        && response.approvals.isEmpty)
    #expect(
      response.thread.messages.map(\.kind) == [
        "status", "text", "text", "tool_call", "tool_call", "artifact", "text", "status",
      ])
    for case .toolCall(let call) in response.thread.messages {
      #expect(call.status == .ok && call.endedAt != nil && call.resultPreview != nil)
    }
    // Streamed text: deltas add up to the final message.
    for case .text(let message) in response.thread.messages {
      let deltas = events.compactMap { event -> String? in
        if case .threadDelta(let delta) = event, delta.messageId == message.id {
          delta.delta
        } else {
          nil
        }
      }
      #expect(deltas.joined() == message.text && message.streaming == false)
    }
    // The answer cites its sources, and the agent writes what it found under the task.
    let sources = try #require(response.thread.sources)
    #expect(sources.count == 2)
    for case .text(let message) in response.thread.messages where message.text.contains("[1](") {
      #expect(sources.contains { message.text.contains("[1](\($0.url))") })
    }
    let note = try await client.readNote(Self.today).content
    #expect(
      note.hasPrefix(
        "- [ ] Research the best indoor herb garden kits\n  - Option A ($129) is the best value ([Guide Example]("
      ))
    #expect(note.hasSuffix(" %%agent:\(threadId)%%\n"))
    #expect(sources.contains { note.contains($0.url) })
    #expect(
      events.contains { if case .vaultChanged(let e) = $0 { e.origin == .agent } else { false } })

    let artifactMeta = try #require(response.thread.artifacts.first)
    #expect(artifactMeta.kind == .markdown && artifactMeta.mimeType == "text/markdown")
    let artifact = try await client.artifact(threadId: threadId, artifactId: artifactMeta.id)
    #expect(artifact.mimeType == "text/markdown" && artifact.data.count == artifactMeta.size)
    #expect(
      String(decoding: artifact.data, as: UTF8.self).hasPrefix(
        "# Research the best indoor herb garden kits"))
    let status = try await client.agentStatus()
    #expect(status.running == 0 && status.pendingApprovals == 0 && status.mode == .mock)
  }

  @Test func approvedRiskyTaskFinishes() async throws {
    let client = Self.client()
    var approval: ApprovalRequest?
    let items = try await Self.collect(client) {
      _ = try await client.writeNote(
        Self.today, content: "- [ ] Order a new kettle\n", baseVersion: .createOnly)
      let pending = try await client.approvals(status: .pending)
      #expect(pending.count == 1)
      approval = pending.first
      let record = try #require(try await client.taskRecords(notePath: Self.today).first)
      #expect(record.status == .waitingApproval && record.summary == "Needs approval")
      #expect(try await client.agentStatus().pendingApprovals == 1)
      let decided = try await client.decideApproval(
        try #require(approval).id, ApprovalDecisionRequest(decision: .approve))
      #expect(decided.status == .approved && decided.scope == .once && decided.decidedAt != nil)
    }
    let pending = try #require(approval)
    #expect(
      pending.toolName == "browser_click" && pending.risk == .high
        && pending.categories == [.payment, .formSubmission])
    #expect(
      pending.summary.contains("Order a new kettle")
        && pending.expiresAt == pending.createdAt + 43_200_000)

    let events = Self.events(items)
    #expect(
      Self.transitions(Self.records(events).map(\.status)) == [
        .idle, .triaging, .working, .waitingApproval, .working, .done,
      ])
    #expect(Self.records(events).last?.summary == "Ordered · arrives in 2 days")
    let upserts = events.compactMap {
      if case .approvalUpsert(let a) = $0 { a.status } else { nil }
    }
    #expect(upserts == [.pending, .approved])

    let thread = try await client.thread(try #require(pending.threadId))
    let calls = thread.thread.messages.compactMap {
      if case .toolCall(let c) = $0 { c } else { nil }
    }
    #expect(
      calls.last?.toolName == "browser_click" && calls.last?.status == .ok
        && calls.last?.resultPreview == "Done")
    #expect(
      thread.thread.messages.contains {
        if case .approval(let m) = $0 { m.approvalId == pending.id } else { false }
      })
    #expect(thread.approvals.map(\.status) == [.approved])

    await #expect(throws: DaemonClientError.self) {
      try await client.decideApproval(pending.id, ApprovalDecisionRequest(decision: .deny))
    }
    do {
      _ = try await client.decideApproval(pending.id, ApprovalDecisionRequest(decision: .deny))
    } catch DaemonClientError.approvalConflict(let conflict) {
      #expect(
        conflict.approval.status == .approved && conflict.message == "Approval is already approved")
    }
  }

  @Test func deniedRiskyTaskIsBlockedWithTheNote() async throws {
    let client = Self.client()
    let items = try await Self.collect(client) {
      _ = try await client.writeNote(
        Self.today, content: "- [ ] Book a haircut for Saturday\n", baseVersion: .createOnly)
      let approval = try #require(try await client.approvals(status: .pending).first)
      #expect(approval.categories == [.booking, .formSubmission])
      _ = try await client.decideApproval(
        approval.id, ApprovalDecisionRequest(decision: .deny, note: "I'll call instead"))
    }
    let events = Self.events(items)
    let records = Self.records(events)
    #expect(
      Self.transitions(records.map(\.status)) == [
        .idle, .triaging, .working, .waitingApproval, .working, .done,
      ])
    #expect(records.last?.summary == "Not booked")
    let threadId = try #require(records.last?.threadId)
    let thread = try await client.thread(threadId)
    let blocked = thread.thread.messages.compactMap {
      if case .toolCall(let c) = $0, c.status == .blocked { c } else { nil }
    }
    #expect(blocked.count == 1 && blocked.first?.resultPreview == "Denied: I'll call instead")
    let texts = thread.thread.messages.compactMap {
      if case .text(let t) = $0 { t.text } else { nil }
    }
    #expect(texts.last?.hasSuffix("> Your note: I'll call instead") == true)
    #expect(
      thread.approvals.first?.status == .denied
        && thread.approvals.first?.decisionNote == "I'll call instead")
    let statuses = thread.thread.messages.compactMap {
      if case .status(let s) = $0 { s.text } else { nil }
    }
    #expect(statuses.contains("Denied — skipping that step") && statuses.last == "Task complete")
  }

  @Test func runsAreDeterministic() async throws {
    func scenario() async throws -> [DaemonStreamItem] {
      let client = Self.client(seed: .demo)
      return try await Self.collect(client) {
        _ = try await client.writeNote(
          Self.today,
          content: "- [ ] Send the quarterly update\n- [ ] Research quiet dishwashers\n",
          baseVersion: .unconditional)
        let approval = try #require(try await client.approvals(status: .pending).first)
        await client.send(.threadRead(threadId: try #require(approval.threadId)))
        _ = try await client.decideApproval(
          approval.id, ApprovalDecisionRequest(decision: .approve, scope: .task))
      }
    }
    let first = try await scenario()
    let second = try await scenario()
    #expect(first.count > 100)
    #expect(first == second)
  }

  @Test func manualClockAdvancesStepByStep() async throws {
    let client = Self.client(.manual())
    let recorder = StreamRecorder(client.events())
    await client.connect()
    _ = try await client.writeNote(
      Self.today, content: "- [ ] Research standing desks\n", baseVersion: .createOnly)
    #expect(try await client.taskRecords(notePath: Self.today).isEmpty)
    #expect(await client.pendingActions == 1)
    await client.advance(by: .milliseconds(1199))
    #expect(try await client.taskRecords(notePath: Self.today).isEmpty, "still settling")
    await client.advance(by: .milliseconds(1))
    #expect(try await client.taskRecords(notePath: Self.today).first?.status == .triaging)
    #expect(try await client.threads(notePath: nil, taskId: nil).isEmpty)
    await client.advance(by: .milliseconds(700))
    let record = try #require(try await client.taskRecords(notePath: Self.today).first)
    #expect(record.status == .working && record.threadId != nil)
    // Mid-stream, the stored message has the words streamed so far.
    await client.advance(by: .milliseconds(26 * 3))
    let partial = try await client.thread(try #require(record.threadId)).thread.messages.last
    guard case .text(let message) = partial else {
      throw TimeoutError(description: "expected a streaming text message")
    }
    #expect(message.streaming == true && message.text == "Picked this up ")
    await client.runUntilIdle()
    #expect(try await client.taskRecords(notePath: Self.today).first?.status == .done)
    #expect(await client.pendingActions == 0)
    #expect(await client.now > Date(epochMillis: Self.start + 5_000))
    await client.disconnect()
    try await recorder.waitForFinish()
  }

  @Test func browseTasksStreamFramesToSubscribers() async throws {
    let client = Self.client(.manual())
    let recorder = StreamRecorder(client.events())
    await client.connect()
    _ = try await client.writeNote(
      Self.today, content: "- [ ] Browse for a standing desk under $300\n", baseVersion: .createOnly
    )
    await client.advance(by: .milliseconds(1200 + 700))
    let threadId = try #require(try await client.taskRecords(notePath: Self.today).first?.threadId)
    await client.send(.surfaceSubscribe(threadId: threadId, surface: .browser))
    await client.runUntilIdle()
    await client.disconnect()
    try await recorder.waitForFinish()

    let frames = recorder.events.compactMap { if case .surfaceFrame(let f) = $0 { f } else { nil } }
    #expect(frames.count == 4, "two browser steps, a frame at the start and in the middle of each")
    let frame = try #require(frames.first)
    #expect(
      frame.threadId == threadId && frame.surface == .browser && frame.mimeType == "image/png")
    #expect(
      frame.url?.hasPrefix("https://guide.example/search?q=") == true
        && frame.action?.kind == "navigate")
    let data = try #require(frame.imageData)
    let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
    let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    #expect(image.width == frame.width && image.height == frame.height)
    let thread = try await client.thread(threadId)
    #expect(thread.thread.surfaces == [.browser])

    // Without a subscription there are no frames.
    let quiet = Self.client()
    let items = try await Self.collect(quiet) {
      _ = try await quiet.writeNote(
        Self.today, content: "- [ ] Browse for a standing desk\n", baseVersion: .createOnly)
    }
    #expect(!Self.events(items).contains { $0.type == "surface.frame" })
  }

  @Test func cancelStopsTheJobAndRetryRestartsIt() async throws {
    let client = Self.client()
    let items = try await Self.collect(client) {
      _ = try await client.writeNote(
        Self.today, content: "- [ ] Pay the electricity bill\n", baseVersion: .createOnly)
      let approval = try #require(try await client.approvals(status: .pending).first)
      let threadId = try #require(approval.threadId)
      #expect(try await client.cancelThread(threadId) == ThreadActionResponse())
      #expect(try await client.approvals(status: .cancelled).map(\.id) == [approval.id])
      let record = try #require(try await client.taskRecords(notePath: Self.today).first)
      #expect(record.status == .cancelled && record.summary == "Stopped by you")
      let calls = try await client.thread(threadId).thread.messages.compactMap {
        if case .toolCall(let c) = $0 { c } else { nil }
      }
      #expect(calls.last?.status == .error && calls.last?.resultPreview == "Cancelled")

      _ = try await client.retryThread(threadId)
      let retried = try #require(try await client.taskRecords(notePath: Self.today).first)
      #expect(retried.status == .waitingApproval && retried.threadId == threadId)
      #expect(try await client.approvals(status: .pending).count == 1)
      #expect(
        try await client.threads(notePath: Self.today, taskId: nil).count == 1,
        "the same thread is reused")
    }
    let statuses = Self.transitions(Self.records(Self.events(items)).map(\.status))
    #expect(
      statuses == [
        .idle, .triaging, .working, .waitingApproval, .cancelled, .triaging, .working,
        .waitingApproval,
      ])
  }

  @Test func userMessagesGetAReply() async throws {
    let client = Self.client()
    _ = try await client.writeNote(
      Self.today, content: "- [ ] Email the landlord about the heater\n", baseVersion: .createOnly)
    let approval = try #require(try await client.approvals(status: .pending).first)
    let threadId = try #require(approval.threadId)
    _ = try await client.postMessage(threadId: threadId, text: "  Mention it's urgent  ")
    var texts = try await client.thread(threadId).thread.messages.compactMap {
      if case .text(let t) = $0 { t } else { nil }
    }
    #expect(
      texts.dropLast().last?.text == "Mention it's urgent" && texts.dropLast().last?.author == "you"
    )
    #expect(
      texts.last?.text == "Got it — I'll factor that in as I go."
        && texts.last?.author == "orchestrator")

    _ = try await client.decideApproval(approval.id, ApprovalDecisionRequest(decision: .approve))
    _ = try await client.postMessage(threadId: threadId, text: "Thanks!")
    texts = try await client.thread(threadId).thread.messages.compactMap {
      if case .text(let t) = $0 { t } else { nil }
    }
    #expect(texts.last?.text.hasPrefix("Thanks! I've added that") == true)

    await #expect(throws: DaemonClientError.self) {
      try await client.postMessage(threadId: threadId, text: "   ")
    }
    await #expect(
      throws: DaemonClientError.http(
        status: 404, body: ApiErrorBody(error: .notFound, message: "Thread not found"))
    ) {
      try await client.postMessage(threadId: "thr_nope", text: "hi")
    }
  }

  @Test func readingAThreadClearsUnread() async throws {
    let client = Self.client()
    _ = try await client.writeNote(
      Self.today, content: "- [ ] Research compost bins\n", baseVersion: .createOnly)
    let record = try #require(try await client.taskRecords(notePath: Self.today).first)
    #expect(record.unread == 3)
    await client.connect()
    await client.send(.threadRead(threadId: try #require(record.threadId)))
    #expect(try await client.taskRecords(notePath: Self.today).first?.unread == 0)
    await client.disconnect()
  }

  @Test func onlyNewOpenTasksInWatchedDailyNotesStartWork() async throws {
    let client = Self.client()
    _ = try await client.writeNote(
      "Projects/Plan.md", content: "- [ ] Research tents\n", baseVersion: .createOnly)
    _ = try await client.writeNote(
      "Daily/2026-09-22.md", content: "- [ ] Research tents\n", baseVersion: .createOnly)
    _ = try await client.writeNote(
      Self.today, content: "- [x] Research tents\n- [ ] \n- [ ] x\n", baseVersion: .createOnly)
    #expect(try await client.threads(notePath: nil, taskId: nil).isEmpty)
    _ = try await client.writeNote(
      "Daily/2026-09-30.md", content: "- [ ] Research tents\n", baseVersion: .createOnly)
    #expect(
      try await client.taskRecords(notePath: "Daily/2026-09-30.md").first?.status == .done,
      "the watch window reaches 7 days ahead")
    _ = try await client.updateSettings(SettingsPatch(agent: .init(enabled: false)))
    _ = try await client.writeNote(
      Self.today, content: "- [x] Research tents\n- [ ] Research sleeping bags\n",
      baseVersion: .unconditional)
    #expect(try await client.taskRecords(notePath: Self.today).isEmpty, "the agent is paused")
  }

  @Test func editsRestartTheSettleDelayAndTypingDefersWork() async throws {
    let client = Self.client(.manual())
    await client.connect()
    _ = try await client.writeNote(Self.today, content: "- [ ] Research ", baseVersion: .createOnly)
    await client.advance(by: .milliseconds(1000))
    _ = try await client.writeNote(
      Self.today, content: "- [ ] Research bikes", baseVersion: .unconditional)
    await client.advance(by: .milliseconds(1000))
    #expect(
      try await client.taskRecords(notePath: Self.today).isEmpty, "the edit restarted the delay")
    await client.send(.editorActivity(notePath: Self.today, line: 0))
    await client.advance(by: .milliseconds(200))
    #expect(
      try await client.taskRecords(notePath: Self.today).isEmpty,
      "the user is still typing on that line")
    await client.advance(by: .milliseconds(1200))
    let record = try #require(try await client.taskRecords(notePath: Self.today).first)
    #expect(record.text == "Research bikes")
    // The task keeps its id when edited in place, and loses its record when deleted.
    _ = try await client.writeNote(
      Self.today, content: "- [ ] Research e-bikes", baseVersion: .unconditional)
    #expect(try await client.taskRecords(notePath: Self.today).first?.taskId == record.taskId)
    _ = try await client.writeNote(Self.today, content: "", baseVersion: .unconditional)
    #expect(try await client.taskRecords(notePath: Self.today).isEmpty)
    await client.runUntilIdle()
    #expect(try await client.agentStatus().running == 0)
    await client.disconnect()
  }

  @Test func concurrencyLimitQueuesTasks() async throws {
    let client = Self.client(.manual())
    _ = try await client.updateSettings(SettingsPatch(agent: .init(maxConcurrentSubagents: 1)))
    _ = try await client.writeNote(
      Self.today, content: "- [ ] Research kettles\n- [ ] Research toasters\n",
      baseVersion: .createOnly)
    await client.advance(by: .milliseconds(1200))
    let records = try await client.taskRecords(notePath: Self.today)
    #expect(records.map(\.status) == [.triaging, .queued])
    #expect(records.last?.summary == "Waiting for a free agent")
    #expect(try await client.agentStatus().queued == 1)
    await client.runUntilIdle()
    #expect(try await client.taskRecords(notePath: Self.today).map(\.status) == [.done, .done])
  }

  @Test func disabledSimulationIsAgentModeOff() async throws {
    let client = InMemoryDaemonClient(seed: .demo, clock: .immediate(), agent: .disabled)
    _ = try await client.writeNote(
      Self.today, content: "- [ ] Order a kettle\n", baseVersion: .unconditional)
    #expect(try await client.taskRecords(notePath: Self.today).isEmpty)
    #expect(try await client.threads(notePath: nil, taskId: nil).isEmpty)
    let status = try await client.agentStatus()
    #expect(status.mode == .off && status.problem != nil && status.connectors.isEmpty)
    #expect(try await client.health().agentMode == .off)
  }

  @Test func realTimeClockDrivesTheSimulation() async throws {
    let client = InMemoryDaemonClient(seed: .empty, clock: .realTime(speed: 400))
    let recorder = StreamRecorder(client.events())
    await client.connect()
    let path = try await client.dailyNote("today", create: true).path
    _ = try await client.writeNote(
      path, content: "- [ ] Research rain jackets\n", baseVersion: .unconditional)
    try await recorder.waitFor("done record", timeout: .seconds(10)) {
      if case .event(.taskRecord(let record)) = $0 { record.status == .done } else { false }
    }
    await client.disconnect()
  }
}
