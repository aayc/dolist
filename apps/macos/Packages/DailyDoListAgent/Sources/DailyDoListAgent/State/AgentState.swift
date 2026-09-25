import DailyDoListModels
import Foundation

/// Everything the agent UI renders, as a plain value. `AgentStore` owns one and publishes its
/// fields; the reducer (extensions in this folder) mirrors `apps/web/src/state/agent-reducer.ts`,
/// hardened for duplicate and out-of-order delivery:
///
/// - every event can be applied twice with the same result (except `thread.delta`, which carries
///   no offset);
/// - nothing regresses: an older record or summary never replaces a newer one, a decided approval
///   never turns pending again, a finished message never resumes streaming, a finished tool call
///   never goes back to running;
/// - text is never lost: a delta for a message that hasn't arrived yet creates a streaming
///   placeholder that the real message later replaces.
struct AgentState: Equatable, Sendable {
  var status: AgentStatusResponse?
  /// Task records by note path. A task lives in exactly one note.
  var recordsByNote: [String: [TaskAgentRecord]] = [:]
  /// Thread summaries by id.
  var threads: [String: ThreadSummary] = [:]
  /// Fully loaded threads by id (opened in the panel), kept live by events.
  var loadedThreads: [String: AgentThread] = [:]
  var approvals: [String: ApprovalRequest] = [:]
  /// Streaming text messages created locally from deltas that arrived before their message.
  var deltaPlaceholders: Set<MessageKey> = []
  /// Ids of optimistic user messages awaiting the daemon's copy, oldest first, by thread.
  var optimisticMessages: [String: [String]] = [:]
  /// The optimistic message each daemon copy replaced (daemon id → local id), so the chat keeps
  /// showing the same row.
  var optimisticReplacements: [String: String] = [:]

  /// Which published fields a mutation touched (so the store only notifies those observers).
  struct Changes: OptionSet, Sendable {
    let rawValue: Int
    static let status = Changes(rawValue: 1 << 0)
    static let records = Changes(rawValue: 1 << 1)
    static let threads = Changes(rawValue: 1 << 2)
    static let loadedThreads = Changes(rawValue: 1 << 3)
    static let approvals = Changes(rawValue: 1 << 4)
  }
}

/// Identifies one message of one thread.
struct MessageKey: Hashable, Sendable {
  var threadId: String
  var messageId: String
}

// MARK: - Queries

extension AgentState {
  /// The record of `taskId`, wherever it lives.
  func record(forTaskId taskId: String) -> TaskAgentRecord? {
    for records in recordsByNote.values {
      if let record = records.first(where: { $0.taskId == taskId }) { return record }
    }
    return nil
  }

  /// The task record behind a thread (by the thread's task id, else by the record's thread id).
  func record(forThread threadId: String) -> TaskAgentRecord? {
    if let taskId = loadedThreads[threadId]?.taskId ?? threads[threadId]?.taskId,
      let record = record(forTaskId: taskId)
    {
      return record
    }
    for records in recordsByNote.values {
      if let record = records.first(where: { $0.threadId == threadId }) { return record }
    }
    return nil
  }

  /// Pending approvals, oldest first (the first one expires first).
  var pendingApprovals: [ApprovalRequest] {
    approvals.values.filter(\.isPending).sorted {
      ($0.createdAt, $0.id) < ($1.createdAt, $1.id)
    }
  }

  /// Threads that have at least one pending approval.
  var threadIdsWithPendingApprovals: Set<String> {
    Set(approvals.values.lazy.filter(\.isPending).compactMap(\.threadId))
  }

  /// A summary computed from a full thread (same as `summarizeThread` in `@ddl/core`).
  static func summarize(_ thread: AgentThread, pendingApprovals: Int) -> ThreadSummary {
    var preview: String?
    for message in thread.messages.reversed() {
      if case .text(let text) = message {
        preview = String(text.text.prefix(200))
        break
      }
    }
    return ThreadSummary(
      id: thread.id, taskId: thread.taskId, notePath: thread.notePath, title: thread.title,
      status: thread.status, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      messageCount: thread.messages.count, lastMessagePreview: preview,
      artifactCount: thread.artifacts.count, surfaces: thread.surfaces,
      pendingApprovals: pendingApprovals)
  }
}
