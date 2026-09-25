import DailyDoListModels
import Foundation
import Observation

/// The chat bar of one thread: the draft, sending it (it shows in the thread at once), stopping
/// the agent, and what the empty input says.
@MainActor
@Observable
final class ComposerModel {
  let store: AgentStore
  let threadId: String
  var text = ""
  /// A stop request is on its way.
  private(set) var isStopping = false

  static let finishedStatuses: Set<TaskAgentStatus> = [.done, .failed, .cancelled, .ignored]

  init(store: AgentStore, threadId: String) {
    self.store = store
    self.threadId = threadId
  }

  var status: TaskAgentStatus? { store.threadStatus(threadId) }

  /// Why replies are off (the agent is off, paused or has a problem).
  var unavailableReason: String? { store.unavailableReason }

  var canSend: Bool {
    unavailableReason == nil && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// The agent is working on the thread: Stop shows beside Send.
  var canStop: Bool { status?.isActive == true }

  /// What the empty input says.
  var placeholder: String {
    if unavailableReason != nil { return "Replies are off while the agent can't act" }
    if !store.pendingApprovals(forThread: threadId).isEmpty {
      return "Approve above, or reply to change course…"
    }
    if let status, Self.finishedStatuses.contains(status) { return "Ask a follow-up…" }
    return "Reply to the agent…"
  }

  /// Sends the draft: it appears in the thread and the input clears in the same update. A failed
  /// send stays in the thread with a retry.
  @discardableResult
  func send() -> Task<Bool, Never>? {
    guard canSend else { return nil }
    let draft = text
    text = ""
    return store.enqueueMessage(threadId: threadId, text: draft)
  }

  /// Stops the agent's work on the thread.
  @discardableResult
  func stop() -> Task<Void, Never>? {
    guard canStop, !isStopping else { return nil }
    isStopping = true
    return Task {
      await store.cancelThread(threadId)
      isStopping = false
    }
  }
}
