import DailyDoListModels
import Testing

@testable import DailyDoListAgent

@Suite("Reducer: threads, messages and deltas")
struct ReducerThreadTests {
  private func message(_ message: ThreadMessage, thread threadId: String = "thr_1") -> ServerEvent {
    .threadMessage(ThreadMessageEvent(threadId: threadId, message: message))
  }

  private func delta(_ text: String, _ messageId: String = "msg_1", _ threadId: String = "thr_1")
    -> ServerEvent
  {
    .threadDelta(ThreadDeltaEvent(threadId: threadId, messageId: messageId, delta: text))
  }

  // MARK: Summaries

  @Test func tracksSummariesAndKeepsTheLoadedThreadInSync() {
    var state = Fixture.loaded()
    let changes = state.apply(
      .threadUpsert(
        Fixture.summary(
          notePath: Fixture.otherNote, title: "Buy oat milk", status: .waitingApproval,
          updatedAt: 5, surfaces: [.browser])),
      now: 0)
    #expect(changes == [.threads, .loadedThreads])
    #expect(state.threads["thr_1"]?.status == .waitingApproval)
    let thread = state.loadedThreads["thr_1"]
    #expect(thread?.status == .waitingApproval)
    #expect(thread?.title == "Buy oat milk")
    #expect(thread?.surfaces == [.browser])
    #expect(thread?.notePath == Fixture.otherNote)
    #expect(thread?.updatedAt == 5)
  }

  @Test func ignoresASummaryOlderThanTheOneWeHave() {
    var state = AgentState()
    _ = state.upsertSummary(Fixture.summary(status: .done, updatedAt: 9))
    let before = state
    #expect(state.upsertSummary(Fixture.summary(status: .working, updatedAt: 3)).isEmpty)
    #expect(state == before)
  }

  @Test func summariesConvergeWhateverTheOrder() {
    let older = Fixture.summary(status: .working, updatedAt: 3)
    let newer = Fixture.summary(status: .done, updatedAt: 9)
    var a = AgentState()
    _ = a.upsertSummary(older)
    _ = a.upsertSummary(newer)
    var b = AgentState()
    _ = b.upsertSummary(newer)
    _ = b.upsertSummary(older)
    #expect(a == b)
  }

  // MARK: Messages

  @Test func ignoresMessagesForThreadsThatAreNotLoaded() {
    var state = AgentState()
    #expect(state.apply(message(Fixture.text()), now: 0).isEmpty)
    #expect(state == AgentState())
  }

  @Test func replacesAMessageInPlace() {
    var state = Fixture.loaded(
      Fixture.thread(messages: [Fixture.toolCall("a"), Fixture.text("b", "hi", streaming: false)]))
    _ = state.apply(message(Fixture.toolCall("a", status: .ok)), now: 0)
    #expect(state.loadedThreads["thr_1"]?.messages.map(\.id) == ["a", "b"])
    guard case .toolCall(let call) = state.loadedThreads["thr_1"]?.messages.first else {
      Issue.record("expected a tool call")
      return
    }
    #expect(call.status == .ok)
  }

  @Test func streamsDeltasAndReplacesThemWithTheFinalVersion() {
    var state = Fixture.loaded()
    _ = state.apply(message(Fixture.text()), now: 0)
    for piece in ["Looking ", "for ", "options…"] { _ = state.apply(delta(piece), now: 0) }
    #expect(Fixture.messageText(state)?.text == "Looking for options…")
    _ = state.apply(
      message(Fixture.text("msg_1", "Looking for options…", streaming: false)), now: 0)
    #expect(state.loadedThreads["thr_1"]?.messages.count == 1)
    #expect(Fixture.messageText(state)?.streaming == false)
  }

  @Test func deltaBeforeItsMessageStartsAPlaceholderSoNoTextIsLost() {
    var state = Fixture.loaded(
      Fixture.thread(messages: [Fixture.toolCall("t", author: "subagent:booking")]))
    #expect(state.apply(delta("for "), now: 42) == .loadedThreads)
    let placeholder = Fixture.messageText(state)
    #expect(placeholder?.text == "for ")
    #expect(placeholder?.streaming == true)
    #expect(placeholder?.role == .agent)
    #expect(placeholder?.author == "subagent:booking")
    #expect(placeholder?.createdAt == 42)

    // The message (carrying the first chunk) arrives late: both parts are kept, in order.
    _ = state.apply(message(Fixture.text("msg_1", "Looking ", author: "subagent:booking")), now: 0)
    #expect(Fixture.messageText(state)?.text == "Looking for ")
    _ = state.apply(delta("options"), now: 0)
    #expect(Fixture.messageText(state)?.text == "Looking for options")
    _ = state.apply(
      message(Fixture.text("msg_1", "Looking for options!", streaming: false)), now: 0)
    #expect(Fixture.messageText(state)?.text == "Looking for options!")
    #expect(Fixture.messageText(state)?.streaming == false)
    #expect(state.deltaPlaceholders.isEmpty)
  }

  @Test func finalMessageAfterDeltasReplacesTheStreamedText() {
    var state = Fixture.loaded()
    _ = state.apply(delta("Hel"), now: 0)
    _ = state.apply(delta("lo"), now: 0)
    _ = state.apply(message(Fixture.text("msg_1", "Hello there", streaming: false)), now: 0)
    #expect(Fixture.messageText(state)?.text == "Hello there")
    #expect(Fixture.messageText(state)?.author == "orchestrator")
    // Deltas still in flight are already part of the final text.
    let final = state
    #expect(state.apply(delta(" there"), now: 0).isEmpty)
    #expect(state == final)
  }

  @Test func duplicateStreamStartAfterDeltasKeepsTheStreamedText() {
    var state = Fixture.loaded()
    _ = state.apply(message(Fixture.text("msg_1", "Looking ")), now: 0)
    _ = state.apply(delta("for options"), now: 0)
    let before = state
    #expect(state.apply(message(Fixture.text("msg_1", "Looking ")), now: 0).isEmpty)
    #expect(state == before)
    #expect(Fixture.messageText(state)?.text == "Looking for options")
  }

  @Test func aStaleStreamingCopyNeverReopensAFinishedMessage() {
    var state = Fixture.loaded()
    _ = state.apply(message(Fixture.text("msg_1", "Done.", streaming: false)), now: 0)
    let final = state
    #expect(state.apply(message(Fixture.text("msg_1", "Do")), now: 0).isEmpty)
    #expect(state == final)
  }

  @Test func aFinishedToolCallNeverGoesBackToRunning() {
    var state = Fixture.loaded()
    _ = state.apply(message(Fixture.toolCall("t", status: .ok, endedAt: 5)), now: 0)
    let finished = state
    #expect(state.apply(message(Fixture.toolCall("t", status: .running)), now: 0).isEmpty)
    #expect(state == finished)
    // …but a later status (e.g. error after ok) is still accepted.
    _ = state.apply(message(Fixture.toolCall("t", status: .error, endedAt: 6)), now: 0)
    guard case .toolCall(let call) = state.loadedThreads["thr_1"]?.messages.first else {
      Issue.record("expected a tool call")
      return
    }
    #expect(call.status == .error)
  }

  @Test func ignoresDeltasThatCannotApply() {
    var state = Fixture.loaded(Fixture.thread(messages: [Fixture.toolCall("tool")]))
    let before = state
    #expect(state.apply(delta("x", "tool"), now: 0).isEmpty)
    #expect(state.apply(delta("", "msg_new"), now: 0).isEmpty)
    #expect(state.apply(delta("x", "msg_1", "thr_unknown"), now: 0).isEmpty)
    #expect(state == before)
  }

  @Test func onlyTheStreamingMessageChangesOnADelta() {
    var state = Fixture.loaded()
    _ = state.apply(message(Fixture.text("msg_0", "done", streaming: false)), now: 0)
    _ = state.apply(message(Fixture.text()), now: 0)
    let first = state.loadedThreads["thr_1"]?.messages.first
    _ = state.apply(delta("x"), now: 0)
    #expect(state.loadedThreads["thr_1"]?.messages.first == first)
    #expect(Fixture.messageText(state)?.text == "x")
  }

  @Test func placeholdersFallBackToTheOrchestratorAsAuthor() {
    #expect(AgentState.likelyStreamingAuthor(in: Fixture.thread()) == "orchestrator")
    let thread = Fixture.thread(messages: [
      Fixture.text("a", "x", streaming: false, author: "subagent:research"),
      Fixture.text("b", "y", streaming: false, author: "orchestrator"),
    ])
    #expect(AgentState.likelyStreamingAuthor(in: thread) == "subagent:research")
  }

  // MARK: Optimistic messages

  @Test func theDaemonsCopyReplacesTheOptimisticMessageInPlace() {
    var state = Fixture.loaded()
    let local = TextMessage(
      id: "local-1", author: "you", createdAt: 5, role: .user, text: "Patio please")
    #expect(state.insertOptimisticMessage(local, threadId: "thr_1") == .loadedThreads)
    _ = state.apply(message(Fixture.toolCall("t")), now: 0)
    _ = state.apply(
      message(Fixture.text("msg_srv", "Patio please", streaming: nil, role: .user, author: "you")),
      now: 0)
    #expect(state.loadedThreads["thr_1"]?.messages.map(\.id) == ["msg_srv", "t"])
    #expect(state.optimisticMessages.isEmpty)
    // A duplicate of the daemon's copy changes nothing.
    let before = state
    _ = state.apply(
      message(Fixture.text("msg_srv", "Patio please", streaming: nil, role: .user, author: "you")),
      now: 0)
    #expect(state == before)
  }

  @Test func someoneElsesMessageDoesNotConsumeTheOptimisticOne() {
    var state = Fixture.loaded()
    let local = TextMessage(
      id: "local-1", author: "you", createdAt: 5, role: .user, text: "Patio please")
    _ = state.insertOptimisticMessage(local, threadId: "thr_1")
    _ = state.apply(
      message(
        Fixture.text("msg_web", "From the web app", streaming: nil, role: .user, author: "you")),
      now: 0)
    #expect(state.loadedThreads["thr_1"]?.messages.map(\.id) == ["local-1", "msg_web"])
    #expect(state.optimisticMessages["thr_1"] == ["local-1"])
    #expect(state.removeOptimisticMessage(id: "local-1", threadId: "thr_1") == .loadedThreads)
    #expect(state.loadedThreads["thr_1"]?.messages.map(\.id) == ["msg_web"])
    #expect(state.optimisticMessages.isEmpty)
  }

  @Test func optimisticMessagesNeedALoadedThread() {
    var state = AgentState()
    let local = TextMessage(id: "local-1", author: "you", createdAt: 5, role: .user, text: "Hi")
    #expect(state.insertOptimisticMessage(local, threadId: "thr_1").isEmpty)
    #expect(state.optimisticMessages.isEmpty)
  }
}
