import DailyDoListModels

/// One row of the chat: a message, or tool calls. Consecutive tool calls that succeeded collapse
/// into one run ("Used 6 tools"); a running call, a failure and a blocked call each stay a row of
/// their own.
struct ChatItem: Identifiable, Sendable {
  enum Content: Sendable {
    case message(ThreadMessage)
    /// One tool call, or several finished ones in a row.
    case tools([ToolCallMessage])
  }

  /// The row's identity: the message's id (the optimistic one it replaced, for the user's own
  /// messages), or the first call's (a run keeps its id as it grows).
  let id: String
  let content: Content

  /// - Parameter aliases: daemon message ids → the ids their rows had (`optimisticReplacements`).
  static func make(_ messages: [ThreadMessage], aliases: [String: String] = [:]) -> [ChatItem] {
    var items: [ChatItem] = []
    var run: [ToolCallMessage] = []
    func flush() {
      if let first = run.first { items.append(ChatItem(id: first.id, content: .tools(run))) }
      run = []
    }
    for message in messages {
      guard case .toolCall(let call) = message else {
        flush()
        items.append(ChatItem(id: aliases[message.id] ?? message.id, content: .message(message)))
        continue
      }
      if call.status == .ok {
        run.append(call)
      } else {
        flush()
        items.append(ChatItem(id: call.id, content: .tools([call])))
      }
    }
    flush()
    return items
  }
}
