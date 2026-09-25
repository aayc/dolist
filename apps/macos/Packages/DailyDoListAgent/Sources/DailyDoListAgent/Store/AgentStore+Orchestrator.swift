import DailyDoListModels
import Foundation

/// The task a decision of the orchestrator acted on (its tool call's `taskId`), and that task's
/// thread when it has one.
public struct OrchestratorTaskLink: Hashable, Sendable {
  public var taskId: String
  public var threadId: String?
  /// The task's text (its thread's title).
  public var title: String
}

/// A request to show one message of the orchestrator's chat: the chat scrolls to it and
/// highlights it once. A new request (another `serial`) for the same message shows it again.
public struct OrchestratorFocus: Hashable, Sendable {
  public var messageId: String
  public var serial: Int
}

extension AgentStore {
  /// Shows `messageId` in the orchestrator's chat (wherever it's open next).
  public func focusOrchestratorMessage(_ messageId: String) {
    orchestratorFocus = OrchestratorFocus(
      messageId: messageId, serial: (orchestratorFocus?.serial ?? 0) + 1)
  }

  /// The chat showed the request `serial`: it's done.
  public func orchestratorFocusShown(_ serial: Int) {
    if orchestratorFocus?.serial == serial { orchestratorFocus = nil }
  }

  /// The orchestrator's own chat, as the inbox lists it (nil until it's known).
  public var orchestratorSummary: ThreadSummary? { threads[OrchestratorThread.id] }

  /// The orchestrator's chat, once loaded.
  public var orchestratorThread: AgentThread? { loadedThreads[OrchestratorThread.id] }

  /// Links for the tasks the orchestrator's tool calls in `messages` act on, by task id: from the
  /// thread summaries (the newest thread of a task) and the loaded records.
  public func taskLinks(for messages: [ThreadMessage]) -> [String: OrchestratorTaskLink] {
    let wanted = Set(messages.compactMap(\.orchestratorTaskId))
    guard !wanted.isEmpty else { return [:] }
    var newest: [String: ThreadSummary] = [:]
    for summary in threads.values {
      guard let taskId = summary.taskId, wanted.contains(taskId) else { continue }
      if let known = newest[taskId], known.updatedAt >= summary.updatedAt { continue }
      newest[taskId] = summary
    }
    var links: [String: OrchestratorTaskLink] = [:]
    for taskId in wanted {
      let thread = newest[taskId]
      let record = record(forTaskId: taskId)
      guard let title = thread?.title ?? record?.text else { continue }
      links[taskId] = OrchestratorTaskLink(
        taskId: taskId, threadId: thread?.id ?? record?.threadId, title: title)
    }
    return links
  }
}

extension ThreadMessage {
  /// The task an orchestrator tool call acts on (the `taskId` of its input), if any.
  public var orchestratorTaskId: String? {
    guard case .toolCall(let call) = self, case .object(let input) = call.input,
      case .string(let taskId)? = input["taskId"], !taskId.isEmpty
    else { return nil }
    return taskId
  }
}
