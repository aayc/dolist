import Foundation

/// Milliseconds since the Unix epoch (JavaScript `Date.now()`); may carry a fraction.
public typealias EpochMillis = Double

extension Date {
  public init(epochMillis: EpochMillis) {
    self.init(timeIntervalSince1970: epochMillis / 1000)
  }

  public var epochMillis: EpochMillis { timeIntervalSince1970 * 1000 }
}

// MARK: - Task agent status

/// Lifecycle of the agent's work on one to-do item (drives the badge next to the task).
public struct TaskAgentStatus: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }

  /// Seen, not yet considered (e.g. still settling while the user types).
  public static let idle: Self = "idle"
  /// The orchestrator is deciding what to do.
  public static let triaging: Self = "triaging"
  /// Delegated, waiting for a free subagent slot.
  public static let queued: Self = "queued"
  public static let working: Self = "working"
  /// Blocked on the user approving a risky action.
  public static let waitingApproval: Self = "waiting_approval"
  /// The agent asked the user a question.
  public static let waitingUser: Self = "waiting_user"
  public static let done: Self = "done"
  public static let failed: Self = "failed"
  public static let cancelled: Self = "cancelled"
  /// The orchestrator decided there is nothing it can do.
  public static let ignored: Self = "ignored"

  public static let active: Set<TaskAgentStatus> = [
    .triaging, .queued, .working, .waitingApproval, .waitingUser,
  ]

  public var isActive: Bool { Self.active.contains(self) }
  /// The user has to do something (approve, answer).
  public var needsUser: Bool { self == .waitingApproval || self == .waitingUser }
}

/// Everything the UI needs to render the agent badge for one task line.
public struct TaskAgentRecord: Codable, Hashable, Sendable, Identifiable {
  public var taskId: String
  public var notePath: String
  /// ISO date (YYYY-MM-DD) when the note is a daily note.
  public var date: String?
  /// Latest task text.
  public var text: String
  /// Last known 0-based line (clients re-resolve locally while editing).
  public var line: Int
  public var status: TaskAgentStatus
  /// One-line status shown inline in the editor, e.g. "Found 3 flights under $400".
  public var summary: String?
  public var threadId: String?
  public var updatedAt: EpochMillis
  /// Agent messages the user has not seen yet.
  public var unread: Int
  /// `.line` when the thread is attached to a line that isn't a task (a heading, a question in
  /// prose…): `taskId` is then the anchor's id and `text` the line. Clients highlight that line.
  public var anchor: TaskAnchorKind?

  public var id: String { taskId }

  public init(
    taskId: String, notePath: String, date: String?, text: String, line: Int,
    status: TaskAgentStatus, summary: String? = nil, threadId: String?, updatedAt: EpochMillis,
    unread: Int, anchor: TaskAnchorKind? = nil
  ) {
    self.taskId = taskId
    self.notePath = notePath
    self.date = date
    self.text = text
    self.line = line
    self.status = status
    self.summary = summary
    self.threadId = threadId
    self.updatedAt = updatedAt
    self.unread = unread
    self.anchor = anchor
  }

  enum CodingKeys: String, CodingKey {
    case taskId, notePath, date, text, line, status, summary, threadId, updatedAt, unread, anchor
  }

  // `date` and `threadId` are required-but-nullable on the wire: always encode them.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(taskId, forKey: .taskId)
    try c.encode(notePath, forKey: .notePath)
    try c.encode(date, forKey: .date)
    try c.encode(text, forKey: .text)
    try c.encode(line, forKey: .line)
    try c.encode(status, forKey: .status)
    try c.encodeIfPresent(summary, forKey: .summary)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(updatedAt, forKey: .updatedAt)
    try c.encode(unread, forKey: .unread)
    try c.encodeIfPresent(anchor, forKey: .anchor)
  }
}

/// What a non-task agent record is attached to (``TaskAgentRecord/anchor``).
public struct TaskAnchorKind: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  /// Any line of the note that isn't a task.
  public static let line: Self = "line"
}

// MARK: - Safety & approvals

public struct RiskLevel: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let low: Self = "low"
  public static let medium: Self = "medium"
  public static let high: Self = "high"
  public static let critical: Self = "critical"
}

public struct SafetyDecision: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let allow: Self = "allow"
  public static let requireApproval: Self = "require_approval"
  public static let deny: Self = "deny"
}

/// Coarse effect categories used by the safety evaluator and shown on approval cards.
public struct ActionCategory: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let read: Self = "read"
  public static let compute: Self = "compute"
  public static let network: Self = "network"
  public static let fileWrite: Self = "file_write"
  public static let browserInput: Self = "browser_input"
  public static let formSubmission: Self = "form_submission"
  public static let computerControl: Self = "computer_control"
  public static let communication: Self = "communication"
  public static let publishing: Self = "publishing"
  public static let payment: Self = "payment"
  public static let booking: Self = "booking"
  public static let account: Self = "account"
  public static let credentials: Self = "credentials"
  public static let privacy: Self = "privacy"
  public static let destructive: Self = "destructive"
  public static let system: Self = "system"
  public static let unknown: Self = "unknown"
}

/// How far an approval reaches. Sent by clients, so a closed set.
public enum ApprovalScope: String, Codable, Hashable, Sendable, CaseIterable {
  case once, task, always
}

public enum ApprovalDecision: String, Codable, Hashable, Sendable, CaseIterable {
  case approve, deny
}

public struct ApprovalStatus: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let pending: Self = "pending"
  public static let approved: Self = "approved"
  public static let denied: Self = "denied"
  public static let expired: Self = "expired"
  public static let cancelled: Self = "cancelled"
}

public struct ApprovalRequest: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var threadId: String?
  public var taskId: String?
  public var toolName: String
  public var toolLabel: String?
  /// Tool arguments as the agent proposed them (sensitive values may be masked by the daemon).
  public var input: JSONValue
  /// Human-readable description of the action.
  public var summary: String
  public var risk: RiskLevel
  public var categories: [ActionCategory]
  /// Why the safety evaluator wants a human in the loop.
  public var reason: String
  public var status: ApprovalStatus
  /// Scope the user granted when approving.
  public var scope: ApprovalScope?
  public var decisionNote: String?
  public var createdAt: EpochMillis
  public var decidedAt: EpochMillis?
  public var expiresAt: EpochMillis?

  public var isPending: Bool { status == .pending }

  public init(
    id: String, threadId: String?, taskId: String?, toolName: String, toolLabel: String? = nil,
    input: JSONValue, summary: String, risk: RiskLevel, categories: [ActionCategory],
    reason: String, status: ApprovalStatus, scope: ApprovalScope? = nil,
    decisionNote: String? = nil, createdAt: EpochMillis, decidedAt: EpochMillis? = nil,
    expiresAt: EpochMillis? = nil
  ) {
    self.id = id
    self.threadId = threadId
    self.taskId = taskId
    self.toolName = toolName
    self.toolLabel = toolLabel
    self.input = input
    self.summary = summary
    self.risk = risk
    self.categories = categories
    self.reason = reason
    self.status = status
    self.scope = scope
    self.decisionNote = decisionNote
    self.createdAt = createdAt
    self.decidedAt = decidedAt
    self.expiresAt = expiresAt
  }

  enum CodingKeys: String, CodingKey {
    case id, threadId, taskId, toolName, toolLabel, input, summary, risk, categories, reason
    case status, scope, decisionNote, createdAt, decidedAt, expiresAt
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    threadId = try c.decodeIfPresent(String.self, forKey: .threadId)
    taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
    toolName = try c.decode(String.self, forKey: .toolName)
    toolLabel = try c.decodeIfPresent(String.self, forKey: .toolLabel)
    // `input: unknown` may be absent (undefined) on the wire.
    input = try c.decodeIfPresent(JSONValue.self, forKey: .input) ?? .null
    summary = try c.decode(String.self, forKey: .summary)
    risk = try c.decode(RiskLevel.self, forKey: .risk)
    categories = try c.decode([ActionCategory].self, forKey: .categories)
    reason = try c.decode(String.self, forKey: .reason)
    status = try c.decode(ApprovalStatus.self, forKey: .status)
    scope = try c.decodeIfPresent(ApprovalScope.self, forKey: .scope)
    decisionNote = try c.decodeIfPresent(String.self, forKey: .decisionNote)
    createdAt = try c.decode(EpochMillis.self, forKey: .createdAt)
    decidedAt = try c.decodeIfPresent(EpochMillis.self, forKey: .decidedAt)
    expiresAt = try c.decodeIfPresent(EpochMillis.self, forKey: .expiresAt)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(threadId, forKey: .threadId)
    try c.encode(taskId, forKey: .taskId)
    try c.encode(toolName, forKey: .toolName)
    try c.encodeIfPresent(toolLabel, forKey: .toolLabel)
    try c.encode(input, forKey: .input)
    try c.encode(summary, forKey: .summary)
    try c.encode(risk, forKey: .risk)
    try c.encode(categories, forKey: .categories)
    try c.encode(reason, forKey: .reason)
    try c.encode(status, forKey: .status)
    try c.encodeIfPresent(scope, forKey: .scope)
    try c.encodeIfPresent(decisionNote, forKey: .decisionNote)
    try c.encode(createdAt, forKey: .createdAt)
    try c.encodeIfPresent(decidedAt, forKey: .decidedAt)
    try c.encodeIfPresent(expiresAt, forKey: .expiresAt)
  }
}

// MARK: - Artifacts

public struct ArtifactKind: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let markdown: Self = "markdown"
  public static let code: Self = "code"
  public static let html: Self = "html"
  public static let image: Self = "image"
  public static let json: Self = "json"
  public static let text: Self = "text"
  public static let file: Self = "file"
}

public struct ArtifactMeta: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var threadId: String
  public var title: String
  public var kind: ArtifactKind
  public var mimeType: String
  /// Code language hint for `code` artifacts.
  public var language: String?
  /// Vault-relative sidecar path of the artifact body.
  public var path: String
  public var size: Int
  public var createdAt: EpochMillis

  public init(
    id: String, threadId: String, title: String, kind: ArtifactKind, mimeType: String,
    language: String? = nil, path: String, size: Int, createdAt: EpochMillis
  ) {
    self.id = id
    self.threadId = threadId
    self.title = title
    self.kind = kind
    self.mimeType = mimeType
    self.language = language
    self.path = path
    self.size = size
    self.createdAt = createdAt
  }
}

// MARK: - Thread messages

/// `"you"`, `"orchestrator"`, `"system"` or `"subagent:<name>"`.
public typealias MessageAuthor = String

extension MessageAuthor {
  /// The subagent's short name when the author is `subagent:<name>`.
  public var subagentName: String? {
    hasPrefix("subagent:") ? String(dropFirst("subagent:".count)) : nil
  }
}

public enum MessageRole: String, Codable, Hashable, Sendable {
  case agent, user, system
}

/// `blocked`: the safety gate refused the call (denied or not approved).
public struct ToolCallStatus: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let running: Self = "running"
  public static let ok: Self = "ok"
  public static let error: Self = "error"
  public static let blocked: Self = "blocked"
}

public struct TextMessage: Codable, Hashable, Sendable {
  public var id: String
  public var author: MessageAuthor
  public var createdAt: EpochMillis
  public var role: MessageRole
  /// Markdown.
  public var text: String
  /// True while tokens are still streaming in (see `thread.delta` events).
  public var streaming: Bool?

  public init(
    id: String, author: MessageAuthor, createdAt: EpochMillis, role: MessageRole, text: String,
    streaming: Bool? = nil
  ) {
    self.id = id
    self.author = author
    self.createdAt = createdAt
    self.role = role
    self.text = text
    self.streaming = streaming
  }
}

public struct ToolCallMessage: Codable, Hashable, Sendable {
  public var id: String
  public var author: MessageAuthor
  public var createdAt: EpochMillis
  public var toolCallId: String
  public var toolName: String
  public var label: String?
  public var input: JSONValue
  public var status: ToolCallStatus
  /// Short, UI-safe preview of the result.
  public var resultPreview: String?
  public var endedAt: EpochMillis?

  public init(
    id: String, author: MessageAuthor, createdAt: EpochMillis, toolCallId: String,
    toolName: String, label: String? = nil, input: JSONValue, status: ToolCallStatus,
    resultPreview: String? = nil, endedAt: EpochMillis? = nil
  ) {
    self.id = id
    self.author = author
    self.createdAt = createdAt
    self.toolCallId = toolCallId
    self.toolName = toolName
    self.label = label
    self.input = input
    self.status = status
    self.resultPreview = resultPreview
    self.endedAt = endedAt
  }

  enum CodingKeys: String, CodingKey {
    case id, author, createdAt, toolCallId, toolName, label, input, status, resultPreview, endedAt
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    author = try c.decode(String.self, forKey: .author)
    createdAt = try c.decode(EpochMillis.self, forKey: .createdAt)
    toolCallId = try c.decode(String.self, forKey: .toolCallId)
    toolName = try c.decode(String.self, forKey: .toolName)
    label = try c.decodeIfPresent(String.self, forKey: .label)
    input = try c.decodeIfPresent(JSONValue.self, forKey: .input) ?? .null
    status = try c.decode(ToolCallStatus.self, forKey: .status)
    resultPreview = try c.decodeIfPresent(String.self, forKey: .resultPreview)
    endedAt = try c.decodeIfPresent(EpochMillis.self, forKey: .endedAt)
  }
}

public struct ApprovalMessage: Codable, Hashable, Sendable {
  public var id: String
  public var author: MessageAuthor
  public var createdAt: EpochMillis
  public var approvalId: String

  public init(id: String, author: MessageAuthor, createdAt: EpochMillis, approvalId: String) {
    self.id = id
    self.author = author
    self.createdAt = createdAt
    self.approvalId = approvalId
  }
}

public struct ArtifactMessage: Codable, Hashable, Sendable {
  public var id: String
  public var author: MessageAuthor
  public var createdAt: EpochMillis
  public var artifactId: String

  public init(id: String, author: MessageAuthor, createdAt: EpochMillis, artifactId: String) {
    self.id = id
    self.author = author
    self.createdAt = createdAt
    self.artifactId = artifactId
  }
}

public struct StatusMessage: Codable, Hashable, Sendable {
  public var id: String
  public var author: MessageAuthor
  public var createdAt: EpochMillis
  public var status: TaskAgentStatus
  public var text: String?

  public init(
    id: String, author: MessageAuthor, createdAt: EpochMillis, status: TaskAgentStatus,
    text: String? = nil
  ) {
    self.id = id
    self.author = author
    self.createdAt = createdAt
    self.status = status
    self.text = text
  }
}

/// One entry of a thread, discriminated by `kind`. Unknown kinds (from a newer daemon) decode to
/// `.unknown` so a thread never fails to load.
public enum ThreadMessage: Hashable, Sendable, Identifiable {
  case text(TextMessage)
  case toolCall(ToolCallMessage)
  case approval(ApprovalMessage)
  case artifact(ArtifactMessage)
  case status(StatusMessage)
  case unknown(kind: String, id: String, raw: JSONValue)

  public var id: String {
    switch self {
    case .text(let m): m.id
    case .toolCall(let m): m.id
    case .approval(let m): m.id
    case .artifact(let m): m.id
    case .status(let m): m.id
    case .unknown(_, let id, _): id
    }
  }

  public var kind: String {
    switch self {
    case .text: "text"
    case .toolCall: "tool_call"
    case .approval: "approval"
    case .artifact: "artifact"
    case .status: "status"
    case .unknown(let kind, _, _): kind
    }
  }

  public var createdAt: EpochMillis {
    switch self {
    case .text(let m): m.createdAt
    case .toolCall(let m): m.createdAt
    case .approval(let m): m.createdAt
    case .artifact(let m): m.createdAt
    case .status(let m): m.createdAt
    case .unknown(_, _, let raw): raw["createdAt"]?.numberValue ?? 0
    }
  }
}

extension ThreadMessage: Codable {
  private enum KindKey: String, CodingKey { case kind, id }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: KindKey.self)
    let kind = try c.decode(String.self, forKey: .kind)
    switch kind {
    case "text": self = .text(try TextMessage(from: decoder))
    case "tool_call": self = .toolCall(try ToolCallMessage(from: decoder))
    case "approval": self = .approval(try ApprovalMessage(from: decoder))
    case "artifact": self = .artifact(try ArtifactMessage(from: decoder))
    case "status": self = .status(try StatusMessage(from: decoder))
    default:
      let id = (try? c.decode(String.self, forKey: .id)) ?? ""
      self = .unknown(kind: kind, id: id, raw: try JSONValue(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .text(let m): try encodeTagged(m, kind: "text", to: encoder)
    case .toolCall(let m): try encodeTagged(m, kind: "tool_call", to: encoder)
    case .approval(let m): try encodeTagged(m, kind: "approval", to: encoder)
    case .artifact(let m): try encodeTagged(m, kind: "artifact", to: encoder)
    case .status(let m): try encodeTagged(m, kind: "status", to: encoder)
    case .unknown(_, _, let raw): try raw.encode(to: encoder)
    }
  }
}

/// Encodes `value` and adds a discriminator field (`kind` for messages, `type` for events).
func encodeTagged<T: Encodable>(
  _ value: T, kind: String, key: String = "kind", to encoder: Encoder
) throws {
  try value.encode(to: encoder)
  var c = encoder.container(keyedBy: AnyCodingKey.self)
  try c.encode(kind, forKey: AnyCodingKey(key))
}

struct AnyCodingKey: CodingKey {
  var stringValue: String
  var intValue: Int? { nil }
  init(_ string: String) { stringValue = string }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { nil }
}

// MARK: - Threads

/// Live visual surfaces a thread can expose (streamed as `surface.frame` events).
public struct SurfaceKind: WireEnum {
  public let rawValue: String
  public init(rawValue: String) { self.rawValue = rawValue }
  public static let browser: Self = "browser"
  public static let computer: Self = "computer"
}

/// The orchestrator's own chat: one thread with this id (`taskId` and `notePath` nil) records
/// each of its turns (what woke it, its text, its tool calls) and takes the user's direct
/// messages. Mirrors `ORCHESTRATOR_THREAD_ID` in `@ddl/core` (the contract's
/// `OrchestratorThreadId`).
public enum OrchestratorThread {
  public static let id = "thr_orchestrator"
  public static let title = "Orchestrator"

  public static func isOrchestrator(_ threadId: String) -> Bool { threadId == id }
}

public struct AgentThread: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var taskId: String?
  public var notePath: String?
  /// Task text snapshot (kept in sync as the task is edited).
  public var title: String
  public var status: TaskAgentStatus
  public var createdAt: EpochMillis
  public var updatedAt: EpochMillis
  public var messages: [ThreadMessage]
  public var artifacts: [ArtifactMeta]
  public var surfaces: [SurfaceKind]
  /// Web pages this thread cites, with what the agent saw of them: citation previews come from
  /// here, never from fetching the page.
  public var sources: [CitedSource]?

  public init(
    id: String, taskId: String?, notePath: String?, title: String, status: TaskAgentStatus,
    createdAt: EpochMillis, updatedAt: EpochMillis, messages: [ThreadMessage] = [],
    artifacts: [ArtifactMeta] = [], surfaces: [SurfaceKind] = [], sources: [CitedSource]? = nil
  ) {
    self.id = id
    self.taskId = taskId
    self.notePath = notePath
    self.title = title
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.messages = messages
    self.artifacts = artifacts
    self.surfaces = surfaces
    self.sources = sources
  }

  enum CodingKeys: String, CodingKey {
    case id, taskId, notePath, title, status, createdAt, updatedAt, messages, artifacts, surfaces,
      sources
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(taskId, forKey: .taskId)
    try c.encode(notePath, forKey: .notePath)
    try c.encode(title, forKey: .title)
    try c.encode(status, forKey: .status)
    try c.encode(createdAt, forKey: .createdAt)
    try c.encode(updatedAt, forKey: .updatedAt)
    try c.encode(messages, forKey: .messages)
    try c.encode(artifacts, forKey: .artifacts)
    try c.encode(surfaces, forKey: .surfaces)
    try c.encodeIfPresent(sources, forKey: .sources)
  }

  /// The orchestrator's own chat (``OrchestratorThread``).
  public var isOrchestrator: Bool { OrchestratorThread.isOrchestrator(id) }
}

/// A web page an agent found or read, as a citation preview.
public struct CitedSource: Codable, Hashable, Sendable {
  public var url: String
  public var title: String?
  /// A sentence or two from the search result or the page.
  public var snippet: String?

  public init(url: String, title: String? = nil, snippet: String? = nil) {
    self.url = url
    self.title = title
    self.snippet = snippet
  }
}

public struct ThreadSummary: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var taskId: String?
  public var notePath: String?
  public var title: String
  public var status: TaskAgentStatus
  public var createdAt: EpochMillis
  public var updatedAt: EpochMillis
  public var messageCount: Int
  public var lastMessagePreview: String?
  public var artifactCount: Int
  public var surfaces: [SurfaceKind]
  public var pendingApprovals: Int

  public init(
    id: String, taskId: String?, notePath: String?, title: String, status: TaskAgentStatus,
    createdAt: EpochMillis, updatedAt: EpochMillis, messageCount: Int,
    lastMessagePreview: String? = nil, artifactCount: Int, surfaces: [SurfaceKind],
    pendingApprovals: Int
  ) {
    self.id = id
    self.taskId = taskId
    self.notePath = notePath
    self.title = title
    self.status = status
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.messageCount = messageCount
    self.lastMessagePreview = lastMessagePreview
    self.artifactCount = artifactCount
    self.surfaces = surfaces
    self.pendingApprovals = pendingApprovals
  }

  enum CodingKeys: String, CodingKey {
    case id, taskId, notePath, title, status, createdAt, updatedAt, messageCount
    case lastMessagePreview, artifactCount, surfaces, pendingApprovals
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(taskId, forKey: .taskId)
    try c.encode(notePath, forKey: .notePath)
    try c.encode(title, forKey: .title)
    try c.encode(status, forKey: .status)
    try c.encode(createdAt, forKey: .createdAt)
    try c.encode(updatedAt, forKey: .updatedAt)
    try c.encode(messageCount, forKey: .messageCount)
    try c.encodeIfPresent(lastMessagePreview, forKey: .lastMessagePreview)
    try c.encode(artifactCount, forKey: .artifactCount)
    try c.encode(surfaces, forKey: .surfaces)
    try c.encode(pendingApprovals, forKey: .pendingApprovals)
  }

  /// The orchestrator's own chat (``OrchestratorThread``).
  public var isOrchestrator: Bool { OrchestratorThread.isOrchestrator(id) }
}

// MARK: - Surfaces

/// The action that produced a frame, for overlays (e.g. a click marker at x/y in frame pixels).
public struct SurfaceFrameAction: Codable, Hashable, Sendable {
  public var kind: String
  public var x: Double?
  public var y: Double?
  public var text: String?

  public init(kind: String, x: Double? = nil, y: Double? = nil, text: String? = nil) {
    self.kind = kind
    self.x = x
    self.y = y
    self.text = text
  }
}

/// One frame of a live surface (browser screencast or desktop screenshot).
public struct SurfaceFrame: Codable, Hashable, Sendable {
  public var threadId: String
  public var surface: SurfaceKind
  /// `image/jpeg` or `image/png`.
  public var mimeType: String
  /// Base64-encoded image bytes.
  public var data: String
  /// Pixel size of the image.
  public var width: Int
  public var height: Int
  /// Browser only.
  public var url: String?
  public var title: String?
  public var action: SurfaceFrameAction?
  public var ts: EpochMillis

  public init(
    threadId: String, surface: SurfaceKind, mimeType: String, data: String, width: Int,
    height: Int, url: String? = nil, title: String? = nil, action: SurfaceFrameAction? = nil,
    ts: EpochMillis
  ) {
    self.threadId = threadId
    self.surface = surface
    self.mimeType = mimeType
    self.data = data
    self.width = width
    self.height = height
    self.url = url
    self.title = title
    self.action = action
    self.ts = ts
  }

  /// Decoded image bytes (nil if `data` isn't valid base64).
  public var imageData: Data? { Data(base64Encoded: data) }
}
