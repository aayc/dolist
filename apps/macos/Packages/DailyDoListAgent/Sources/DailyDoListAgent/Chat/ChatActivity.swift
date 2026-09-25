import DailyDoListModels
import Foundation

/// What the agent is doing right now, for the live row at the end of a chat. Derived from what
/// the thread already has (its status, tool calls, approvals, streaming text); the web app derives
/// it the same way, with the same wording.
struct ChatActivity: Hashable, Sendable {
  enum Kind: Hashable, Sendable {
    /// Queued for a free agent.
    case waitingToStart
    /// A pending approval of this thread (`messageId`: its card in the chat).
    case approval(approvalId: String, messageId: String?)
    /// A tool call running.
    case tool(name: String)
    case thinking
  }

  var kind: Kind
  var label: String
  /// When the current step began (for "· 12s"); nil when unknown.
  var since: EpochMillis?

  /// Statuses whose agent is queued or running: the row shows only then.
  static let liveStatuses: Set<TaskAgentStatus> = [.queued, .triaging, .working, .waitingApproval]

  /// The activity of a thread, or nil when the row shouldn't show.
  /// - Parameters:
  ///   - pendingApprovals: the thread's pending approvals, oldest first.
  ///   - isTextActive: agent text is typing out or streaming (the caret says enough then).
  static func current(
    status: TaskAgentStatus, messages: [ThreadMessage], pendingApprovals: [ApprovalRequest],
    isTextActive: Bool
  ) -> ChatActivity? {
    guard liveStatuses.contains(status) else { return nil }
    if let approval = pendingApprovals.first {
      let card = messages.last {
        if case .approval(let item) = $0 { item.approvalId == approval.id } else { false }
      }
      return ChatActivity(
        kind: .approval(approvalId: approval.id, messageId: card?.id),
        label: "Waiting for your approval", since: approval.createdAt)
    }
    if status == .queued {
      return ChatActivity(
        kind: .waitingToStart, label: "Waiting to start…", since: lastActivity(in: messages))
    }
    for case .toolCall(let call) in messages.reversed() where call.status == .running {
      return ChatActivity(
        kind: .tool(name: call.toolName), label: label(for: call), since: call.createdAt)
    }
    if isTextActive { return nil }
    return ChatActivity(kind: .thinking, label: "Thinking…", since: lastActivity(in: messages))
  }

  /// The latest thing that happened in the thread (a message, a tool call ending).
  static func lastActivity(in messages: [ThreadMessage]) -> EpochMillis? {
    var latest: EpochMillis?
    for message in messages {
      var time = message.createdAt
      if case .toolCall(let call) = message, let endedAt = call.endedAt {
        time = max(time, endedAt)
      }
      latest = max(latest ?? time, time)
    }
    return latest
  }

  /// "12s", "1m 5s", "2h 3m" once the step has taken 3 s; nil before.
  static func elapsed(since: EpochMillis?, now: Date) -> String? {
    guard let since else { return nil }
    let seconds = Int(((now.epochMillis - since) / 1000).rounded(.down))
    guard seconds >= 3 else { return nil }
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
    return "\(seconds / 3600)h \(seconds / 60 % 60)m"
  }

  // MARK: Labels

  /// Quoted strings are clipped to this many characters (with the ellipsis).
  static let clipLength = 40

  /// What a running tool call is doing, in words: "Opening Safari…", "Searching the web for
  /// “espresso grinders”…". Inputs reach the client already redacted by the daemon.
  static func label(for call: ToolCallMessage) -> String {
    func field(_ key: String) -> String? {
      guard let value = call.input[key]?.stringValue else { return nil }
      let cleaned = value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
      return cleaned.isEmpty ? nil : clip(cleaned)
    }
    let app = field("app")
    let inApp = app.map { " in \($0)" } ?? ""
    switch call.toolName {
    case "computer_open_app":
      return "Opening \(app ?? "an app")…"
    case "computer_app_state", "computer_screenshot":
      return app.map { "Looking at \($0)…" } ?? "Looking at the screen…"
    case "computer_press":
      return field("element").map { "Pressing “\($0)”\(inApp)…" } ?? "Pressing a control\(inApp)…"
    case "computer_set_value", "computer_type":
      return "Typing\(inApp)…"
    case "computer_key":
      return field("combo").map { "Pressing \($0)\(inApp)…" } ?? "Pressing a key\(inApp)…"
    case "computer_click":
      return "Clicking\(app.map { " in \($0)" } ?? " on the screen")…"
    case "computer_scroll":
      return "Scrolling\(app.map { " in \($0)" } ?? " on the screen")…"
    case "browser_navigate":
      return host(of: call.input["url"]?.stringValue).map { "Opening \($0)…" } ?? "Opening a page…"
    case "browser_snapshot", "browser_extract_text":
      return "Reading the page…"
    case "web_search":
      return field("query").map { "Searching the web for “\($0)”…" } ?? "Searching the web…"
    case "web_fetch":
      return host(of: call.input["url"]?.stringValue).map { "Reading \($0)…" }
        ?? "Reading a page…"
    case "read_note", "search_notes":
      return "Reading your notes…"
    case "edit_note":
      return "Editing your note…"
    case "bash":
      return "Running a command…"
    case "read", "grep", "find", "ls":
      return "Looking through files…"
    case "write", "edit":
      return "Writing files…"
    default:
      if call.toolName.hasPrefix("browser_") { return "Working in the browser…" }
      if let server = connectorServer(call.toolName) { return "Using \(clip(server))…" }
      let label = call.label?.trimmingCharacters(in: .whitespacesAndNewlines)
      let base = label.flatMap { $0.isEmpty ? nil : $0 } ?? humanize(call.toolName)
      return base.hasSuffix("…") ? base : "\(base)…"
    }
  }

  /// At most `clipLength` characters, the last one an ellipsis when cut.
  static func clip(_ text: String) -> String {
    guard text.count > clipLength else { return text }
    return String(text.prefix(clipLength - 1)).trimmingCharacters(in: .whitespaces) + "…"
  }

  /// The lowercased host of an absolute URL ("https://Shop.example/cart" → "shop.example").
  static func host(of url: String?) -> String? {
    guard let url, let components = URLComponents(string: url.trimmingCharacters(in: .whitespaces)),
      components.scheme != nil, let host = components.host, !host.isEmpty
    else { return nil }
    return clip(host.lowercased())
  }

  /// `mcp__{server}__{tool}` → the server.
  static func connectorServer(_ toolName: String) -> String? {
    guard toolName.hasPrefix("mcp__") else { return nil }
    let rest = toolName.dropFirst("mcp__".count)
    let server = rest.range(of: "__").map { rest[..<$0.lowerBound] } ?? rest
    return server.isEmpty ? nil : String(server)
  }
}
