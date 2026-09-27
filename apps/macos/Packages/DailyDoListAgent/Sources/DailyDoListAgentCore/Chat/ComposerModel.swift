import DailyDoListModels
import Foundation
import Observation

/// The chat bar of one thread: the draft, sending it (it shows in the thread at once), stopping
/// the agent, and what the empty input says.
@MainActor
@Observable
package final class ComposerModel {
  package let store: AgentStore
  package let threadId: String
  package var text = ""
  /// A stop request is on its way.
  package private(set) var isStopping = false

  package static let finishedStatuses: Set<TaskAgentStatus> = [
    .done, .failed, .cancelled, .ignored,
  ]

  package init(store: AgentStore, threadId: String) {
    self.store = store
    self.threadId = threadId
  }

  package var status: TaskAgentStatus? { store.threadStatus(threadId) }

  /// Why replies are off (read-only on this device, or the agent is off, paused or has a problem).
  package var unavailableReason: String? { store.readOnly?.reason ?? store.unavailableReason }

  package var canSend: Bool {
    unavailableReason == nil && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// The agent is working on the thread: Stop shows beside Send.
  package var canStop: Bool { status?.isActive == true }

  /// Stop can't reach the agent from this device (it shows, disabled, with the reason).
  package var stopUnavailableReason: String? { store.readOnly?.reason }

  /// What the empty input says.
  package var placeholder: String {
    if store.readOnly != nil { return "Replies are off while this is read-only" }
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
  package func send() -> Task<Bool, Never>? {
    guard canSend else { return nil }
    let draft = text
    text = ""
    return store.enqueueMessage(threadId: threadId, text: draft)
  }

  /// Stops the agent's work on the thread.
  @discardableResult
  package func stop() -> Task<Void, Never>? {
    guard canStop, !isStopping, stopUnavailableReason == nil else { return nil }
    isStopping = true
    return Task {
      await store.cancelThread(threadId)
      isStopping = false
    }
  }
}
