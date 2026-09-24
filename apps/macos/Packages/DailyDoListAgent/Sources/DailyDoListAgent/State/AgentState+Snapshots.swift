import DailyDoListModels
import Foundation

// REST snapshots (boot, reconnect resync, opening a thread). A snapshot is the daemon's state
// when it answered; live events that arrived while it was in flight may be newer, so callers pass
// the ids those events touched (`preserving`) and the snapshot never overwrites or drops them.

extension AgentState {
  /// Applies a thread list. `notePath` is the list's filter: summaries of other notes are kept
  /// (nil = the list is every thread, so it replaces all summaries).
  mutating func applyThreadList(
    _ list: [ThreadSummary], notePath: String?, preserving: Set<String> = []
  ) -> Changes {
    let before = threads
    var next = threads.filter { id, summary in
      (notePath != nil && summary.notePath != notePath) || preserving.contains(id)
    }
    for summary in list {
      if preserving.contains(summary.id), let local = next[summary.id],
        local.updatedAt > summary.updatedAt
      {
        continue
      }
      next[summary.id] = summary
    }
    threads = next
    var changes: Changes = threads == before ? [] : .threads
    for (id, thread) in loadedThreads {
      guard let summary = threads[id], summary.updatedAt >= thread.updatedAt else { continue }
      if syncHeader(ofThread: id, from: summary) { changes.insert(.loadedThreads) }
    }
    return changes
  }

  /// Applies the list of pending approvals: upserts them, and forgets local pending approvals the
  /// daemon no longer lists (decided or expired while we weren't listening). Decided approvals
  /// are kept; loaded threads still show them.
  mutating func applyPendingApprovals(
    _ list: [ApprovalRequest], preserving: Set<String> = []
  ) -> Changes {
    var changes: Changes = []
    let listed = Set(list.map(\.id))
    for (id, approval) in approvals
    where approval.isPending && !listed.contains(id) && !preserving.contains(id) {
      approvals[id] = nil
      changes.insert(.approvals)
    }
    for approval in list { changes.formUnion(upsertApproval(approval)) }
    return changes
  }

  /// Applies a full thread (`GET /api/threads/:id`) with its approvals.
  ///
  /// - Parameter inFlight: ids of optimistic messages whose request hasn't finished; they stay
  ///   (at the end) unless the thread already contains a new user message with the same text.
  mutating func applyThreadResponse(
    _ response: ThreadResponse, inFlight: Set<String> = []
  ) -> Changes {
    var changes: Changes = []
    for approval in response.approvals { changes.formUnion(upsertApproval(approval)) }

    var thread = response.thread
    let previous = loadedThreads[thread.id]
    var kept: [String] = []
    if let previous, let locals = optimisticMessages[thread.id] {
      let seen = Set(previous.messages.map(\.id))
      var delivered: [String: Int] = [:]
      for case .text(let text) in thread.messages where text.role == .user && !seen.contains(text.id) {
        delivered[text.text, default: 0] += 1
      }
      for id in locals where inFlight.contains(id) {
        guard let message = previous.messages.first(where: { $0.id == id }),
          case .text(let text) = message
        else { continue }
        if let count = delivered[text.text], count > 0 {
          delivered[text.text] = count - 1
          continue
        }
        thread.messages.append(message)
        kept.append(id)
      }
    }
    optimisticMessages[thread.id] = kept.isEmpty ? nil : kept
    deltaPlaceholders = deltaPlaceholders.filter { $0.threadId != thread.id }

    if let known = threads[thread.id], known.updatedAt > thread.updatedAt {
      // An event newer than this response already updated the summary.
      thread.title = known.title
      thread.status = known.status
      thread.updatedAt = known.updatedAt
      thread.surfaces = known.surfaces
      thread.notePath = known.notePath
    } else {
      let pending = response.approvals.filter(\.isPending).count
      let summary = Self.summarize(response.thread, pendingApprovals: pending)
      if threads[thread.id] != summary {
        threads[thread.id] = summary
        changes.insert(.threads)
      }
    }
    if previous != thread {
      loadedThreads[thread.id] = thread
      changes.insert(.loadedThreads)
    }
    return changes
  }
}
