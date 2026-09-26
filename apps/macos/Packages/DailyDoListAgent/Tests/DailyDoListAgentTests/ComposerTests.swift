import AppKit
import DailyDoListAgentTestSupport
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import SwiftUI
import Testing

@testable import DailyDoListAgent

@MainActor
@Suite("Composer keys")
struct ComposerTests {
  private func coordinator(onSubmit: @escaping () -> Void) -> ComposerTextView.Coordinator {
    ComposerTextView.Coordinator(
      parent: ComposerTextView(
        text: .constant("Hi"), height: .constant(22), isEditable: true, onSubmit: onSubmit))
  }

  @Test func returnSendsAndOtherCommandsPassThrough() {
    var submitted = 0
    let coordinator = coordinator { submitted += 1 }
    coordinator.modifierFlags = { [] }
    let textView = NSTextView()
    #expect(coordinator.textView(textView, doCommandBy: #selector(NSResponder.insertNewline(_:))))
    #expect(submitted == 1)
    #expect(!coordinator.textView(textView, doCommandBy: #selector(NSResponder.moveUp(_:))))
    #expect(!coordinator.textView(textView, doCommandBy: #selector(NSResponder.insertTab(_:))))
    #expect(submitted == 1)
  }

  @Test(arguments: [NSEvent.ModifierFlags.shift, .option])
  func shiftOrOptionReturnAddsALine(modifier: NSEvent.ModifierFlags) {
    var submitted = 0
    let coordinator = coordinator { submitted += 1 }
    coordinator.modifierFlags = { modifier }
    let textView = NSTextView()
    textView.string = "Line one"
    textView.setSelectedRange(NSRange(location: 8, length: 0))
    #expect(coordinator.textView(textView, doCommandBy: #selector(NSResponder.insertNewline(_:))))
    #expect(submitted == 0)
    #expect(textView.string == "Line one\n")
  }

  @Test func returnFinishesInputMethodCompositionInsteadOfSending() {
    var submitted = 0
    let coordinator = coordinator { submitted += 1 }
    let textView = NSTextView()
    textView.setMarkedText(
      "にほ", selectedRange: NSRange(location: 2, length: 0),
      replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(textView.hasMarkedText())
    #expect(!coordinator.textView(textView, doCommandBy: #selector(NSResponder.insertNewline(_:))))
    #expect(submitted == 0)
  }

  // MARK: Growing

  @Test func growsFromOneLineToEightThenScrolls() {
    let line = ComposerMetrics.lineHeight
    #expect(ComposerMetrics.minHeight == line + 6)
    #expect(ComposerMetrics.maxHeight == line * 8 + 6)
    #expect(ComposerMetrics.height(forUsedHeight: 0) == ComposerMetrics.minHeight)
    #expect(ComposerMetrics.height(forUsedHeight: line) == ComposerMetrics.minHeight)
    #expect(ComposerMetrics.height(forUsedHeight: line * 3) == line * 3 + 6)
    #expect(ComposerMetrics.height(forUsedHeight: line * 30) == ComposerMetrics.maxHeight)
  }

  @Test func measuresTheTextItHolds() {
    let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 280, height: 20))
    textView.font = ComposerMetrics.font
    textView.textContainerInset = ComposerMetrics.inset
    func height(_ text: String) -> CGFloat {
      textView.string = text
      return ComposerTextView.Coordinator.measuredHeight(of: textView)
    }
    #expect(height("") == ComposerMetrics.minHeight)
    #expect(height("One line") == ComposerMetrics.minHeight)
    let three = height("One\nTwo\nThree")
    #expect(three > ComposerMetrics.minHeight && three < ComposerMetrics.maxHeight)
    #expect(abs(three - (ComposerMetrics.lineHeight * 3 + 6)) <= 2)
    #expect(
      height(Array(repeating: "Line", count: 30).joined(separator: "\n"))
        == ComposerMetrics.maxHeight)
  }

  /// The input's height in a real chat bar holding `draft`.
  private func hostedInputHeight(draft: String) async throws -> CGFloat {
    let store = SampleData.makeStore(now: SnapshotTests.now)
    let model = ComposerModel(store: store, threadId: SampleData.coffeeThreadId)
    model.text = draft
    let host = NSHostingView(rootView: Composer(model: model).frame(width: 400))
    host.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    defer { window.close() }
    for _ in 0..<6 {
      host.layoutSubtreeIfNeeded()
      try await Task.sleep(for: .milliseconds(20))
    }
    func textView(in view: NSView) -> NSTextView? {
      if let textView = view as? NSTextView { return textView }
      return view.subviews.lazy.compactMap(textView(in:)).first
    }
    let input = try #require(textView(in: host)?.enclosingScrollView)
    return input.frame.height
  }

  @Test func theChatBarGrowsWithItsDraftUpToEightLines() async throws {
    let line = ComposerMetrics.lineHeight
    #expect(try await hostedInputHeight(draft: "") == ComposerMetrics.minHeight)
    let two = try await hostedInputHeight(draft: "Pick the patio one,\nby the window.")
    #expect(abs(two - (line * 2 + 6)) <= 2)
    let many = Array(repeating: "Another line", count: 20).joined(separator: "\n")
    #expect(try await hostedInputHeight(draft: many) == ComposerMetrics.maxHeight)
  }
}

@MainActor
@Suite("Composer model")
struct ComposerModelTests {
  let client = FakeDaemonClient()
  let store: AgentStore
  let model: ComposerModel

  init() {
    store = AgentStore(client: client, now: { Date(epochMillis: 1_000) })
    model = ComposerModel(store: store, threadId: "thr_1")
  }

  private func load(status: TaskAgentStatus = .working, approvals: [ApprovalRequest] = []) async {
    let thread = Fixture.thread(status: status)
    client.script { $0.thread = { _ in ThreadResponse(thread: thread, approvals: approvals) } }
    await store.loadThread("thr_1")
  }

  @Test func sendingShowsTheMessageAtOnceAndClearsTheInput() async throws {
    await load()
    let gate = Gate()
    client.script {
      $0.postMessage = { _, _ in
        await gate.wait()
        return ThreadActionResponse(ok: true, pending: true)
      }
    }
    model.text = "  Book the 7pm slot \n"
    #expect(model.canSend)
    let sent = try #require(model.send())
    #expect(model.text.isEmpty)
    guard case .text(let local)? = store.thread("thr_1")?.messages.last else {
      Issue.record("the message shows in the same update")
      return
    }
    #expect(local.text == "Book the 7pm slot")
    #expect(store.sendingMessageIds == [local.id])
    #expect(await waitForArrivals(gate))
    await gate.open()
    #expect(await sent.value)
    #expect(store.sendingMessageIds.isEmpty)
  }

  @Test func aFailedSendOffersARetryAndTheInputStaysClear() async throws {
    await load()
    client.script { $0.postMessage = { _, _ in throw DaemonClientError.unreachable("offline") } }
    model.text = "Hello"
    #expect(await model.send()?.value == false)
    #expect(model.text.isEmpty)
    let id = try #require(store.unsentMessages.keys.first)
    client.script { $0.postMessage = { _, _ in ThreadActionResponse(ok: true, pending: true) } }
    #expect(await store.retryMessage(id, threadId: "thr_1"))
    #expect(store.unsentMessages.isEmpty)
  }

  @Test func blankDraftsAndAPausedAgentDontSend() async {
    await load()
    model.text = " \n "
    #expect(!model.canSend)
    #expect(model.send() == nil)
    store.apply(.agentStatus(Fixture.status(enabled: false)))
    model.text = "Hello"
    #expect(!model.canSend)
    #expect(model.send() == nil)
    #expect(model.text == "Hello")
    #expect(client.calls("postMessage").count == 0)
  }

  @Test func stopShowsWhileTheAgentWorksAndCancelsOnce() async throws {
    await load(status: .working)
    #expect(model.canStop)
    let gate = Gate()
    client.script {
      $0.cancelThread = { _ in
        await gate.wait()
        return ThreadActionResponse()
      }
    }
    let stopping = try #require(model.stop())
    #expect(model.isStopping)
    #expect(model.stop() == nil, "a second click while stopping does nothing")
    #expect(await waitForArrivals(gate))
    await gate.open()
    await stopping.value
    #expect(!model.isStopping)
    #expect(client.calls("cancelThread").count == 1)
  }

  @Test(arguments: [TaskAgentStatus.done, .failed, .cancelled, .idle])
  func noStopWhenTheAgentIsntWorking(status: TaskAgentStatus) async {
    await load(status: status)
    #expect(!model.canStop)
    #expect(model.stop() == nil)
  }

  @Test func thePlaceholderSaysWhatAReplyDoes() async {
    await load(status: .working)
    #expect(model.placeholder == "Reply to the agent…")
    store.apply(.approvalUpsert(Fixture.approval()))
    #expect(model.placeholder == "Approve above, or reply to change course…")
    store.apply(.approvalUpsert(Fixture.approval(status: .approved, decidedAt: 5)))
    store.apply(.threadUpsert(Fixture.summary(status: .done, updatedAt: 10)))
    #expect(model.placeholder == "Ask a follow-up…")
    store.apply(.agentStatus(Fixture.status(enabled: false)))
    #expect(model.placeholder == "Replies are off while the agent can't act")
  }
}
