import DailyDoListModels
import Foundation

@testable import DailyDoListAgent

/// Small synthetic builders (same defaults as the web reducer tests).
enum Fixture {
  static let note = "Daily/2026-09-23.md"
  static let otherNote = "Journal/2026-09-23.md"

  static func record(
    _ taskId: String = "tsk_1", notePath: String = note, status: TaskAgentStatus = .triaging,
    threadId: String? = nil, updatedAt: EpochMillis = 10, unread: Int = 0, line: Int = 0,
    text: String = "Buy milk"
  ) -> TaskAgentRecord {
    TaskAgentRecord(
      taskId: taskId, notePath: notePath, date: "2026-09-23", text: text, line: line,
      status: status, threadId: threadId, updatedAt: updatedAt, unread: unread)
  }

  static func summary(
    _ id: String = "thr_1", taskId: String? = "tsk_1", notePath: String? = note,
    title: String = "Buy milk", status: TaskAgentStatus = .working, createdAt: EpochMillis = 1,
    updatedAt: EpochMillis = 2, surfaces: [SurfaceKind] = [], pendingApprovals: Int = 0,
    preview: String? = nil, messageCount: Int = 0, artifactCount: Int = 0
  ) -> ThreadSummary {
    ThreadSummary(
      id: id, taskId: taskId, notePath: notePath, title: title, status: status,
      createdAt: createdAt, updatedAt: updatedAt, messageCount: messageCount,
      lastMessagePreview: preview, artifactCount: artifactCount, surfaces: surfaces,
      pendingApprovals: pendingApprovals)
  }

  static func thread(
    _ id: String = "thr_1", taskId: String? = "tsk_1", notePath: String? = note,
    title: String = "Buy milk", status: TaskAgentStatus = .working, createdAt: EpochMillis = 1,
    updatedAt: EpochMillis = 1, messages: [ThreadMessage] = [], artifacts: [ArtifactMeta] = [],
    surfaces: [SurfaceKind] = []
  ) -> AgentThread {
    AgentThread(
      id: id, taskId: taskId, notePath: notePath, title: title, status: status,
      createdAt: createdAt, updatedAt: updatedAt, messages: messages, artifacts: artifacts,
      surfaces: surfaces)
  }

  static func text(
    _ id: String = "msg_1", _ text: String = "", streaming: Bool? = true,
    role: MessageRole = .agent,
    author: MessageAuthor = "orchestrator", createdAt: EpochMillis = 1
  ) -> ThreadMessage {
    .text(
      TextMessage(
        id: id, author: author, createdAt: createdAt, role: role, text: text, streaming: streaming))
  }

  static func toolCall(
    _ id: String = "msg_tool", status: ToolCallStatus = .running, toolName: String = "web_search",
    author: MessageAuthor = "subagent:research", createdAt: EpochMillis = 1,
    endedAt: EpochMillis? = nil
  ) -> ThreadMessage {
    .toolCall(
      ToolCallMessage(
        id: id, author: author, createdAt: createdAt, toolCallId: "call_\(id)", toolName: toolName,
        input: ["query": "x"], status: status, endedAt: endedAt))
  }

  static func approval(
    _ id: String = "apr_1", threadId: String? = "thr_1", status: ApprovalStatus = .pending,
    createdAt: EpochMillis = 1, risk: RiskLevel = .high, scope: ApprovalScope? = nil,
    decidedAt: EpochMillis? = nil, expiresAt: EpochMillis? = nil, summary: String = "Place order"
  ) -> ApprovalRequest {
    ApprovalRequest(
      id: id, threadId: threadId, taskId: "tsk_1", toolName: "browser_click",
      toolLabel: "Click “Place order”", input: ["element": "Place order button"], summary: summary,
      risk: risk, categories: [.payment], reason: "Spends money", status: status, scope: scope,
      createdAt: createdAt, decidedAt: decidedAt, expiresAt: expiresAt)
  }

  static func status(
    enabled: Bool = true, running: Int = 1, queued: Int = 0, mode: AgentMode = .mock,
    problem: String? = nil
  ) -> AgentStatusResponse {
    AgentStatusResponse(
      mode: mode, enabled: enabled, model: "m", running: running, queued: queued,
      pendingApprovals: 0, connectors: [],
      execution: ExecutionStatus(
        provider: "mock",
        capabilities: ExecutionCapabilities(shell: false, browser: true, computer: true)),
      problem: problem)
  }

  static func frame(
    threadId: String = "thr_1", surface: SurfaceKind = .browser, ts: EpochMillis = 1,
    action: SurfaceFrameAction? = nil, data: String = pixelPNG
  ) -> SurfaceFrame {
    SurfaceFrame(
      threadId: threadId, surface: surface, mimeType: "image/png", data: data, width: 4, height: 2,
      url: "https://shop.example/cart", title: "Cart", action: action, ts: ts)
  }

  /// A 1×1 PNG.
  static let pixelPNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

  /// State with one loaded thread (like the web tests' `loaded()`).
  static func loaded(_ thread: AgentThread = thread(), approvals: [ApprovalRequest] = [])
    -> AgentState
  {
    var state = AgentState()
    _ = state.applyThreadResponse(ThreadResponse(thread: thread, approvals: approvals))
    return state
  }

  static func messageText(_ state: AgentState, _ threadId: String = "thr_1", _ id: String = "msg_1")
    -> TextMessage?
  {
    guard
      case .text(let text) = state.loadedThreads[threadId]?.messages.first(where: { $0.id == id })
    else {
      return nil
    }
    return text
  }
}

/// Deterministic generator for the randomized tests.
struct SplitMix64: RandomNumberGenerator {
  private var state: UInt64

  init(seed: UInt64) { state = seed }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
