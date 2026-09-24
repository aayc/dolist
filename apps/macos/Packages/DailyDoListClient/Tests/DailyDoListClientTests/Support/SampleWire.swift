import DailyDoListModels
import Foundation

/// Synthetic wire values for tests.
enum SampleWire {
  static let note = NoteResponse(
    path: "Ideas.md", content: "theirs", version: "9f8e7d6c5b4a39", mtime: 1_790_000_000_000)

  static let record = TaskAgentRecord(
    taskId: "tsk_1", notePath: "Daily/2026-09-23.md", date: "2026-09-23", text: "Book a table",
    line: 2, status: .waitingApproval, summary: "Needs approval", threadId: "thr_1",
    updatedAt: 1_790_000_000_000, unread: 1)

  static let approval = ApprovalRequest(
    id: "apr_1", threadId: "thr_1", taskId: "tsk_1", toolName: "browser_click", toolLabel: "Click",
    input: ["element": "Book button"], summary: "Click “Book”", risk: .high, categories: [.booking],
    reason: "Books in your name", status: .pending, createdAt: 1_790_000_002_000,
    expiresAt: 1_790_043_202_000)

  static let summary = ThreadSummary(
    id: "thr_1", taskId: "tsk_1", notePath: "Daily/2026-09-23.md", title: "Book a table",
    status: .working, createdAt: 1_790_000_000_000, updatedAt: 1_790_000_005_000, messageCount: 2,
    lastMessagePreview: "On it", artifactCount: 0, surfaces: [.browser], pendingApprovals: 1)

  static let thread = AgentThread(
    id: "thr_1", taskId: "tsk_1", notePath: "Daily/2026-09-23.md", title: "Book a table",
    status: .working, createdAt: 1_790_000_000_000, updatedAt: 1_790_000_005_000,
    messages: [
      .text(
        TextMessage(
          id: "msg_1", author: "orchestrator", createdAt: 1_790_000_001_000, role: .agent,
          text: "On it"))
    ])

  static let status = AgentStatusResponse(
    mode: .live, enabled: true, model: "test/model", running: 1, queued: 0, pendingApprovals: 1,
    connectors: [ConnectorStatus(name: "mail", transport: .http, state: .connected, toolCount: 3)],
    execution: ExecutionStatus(
      provider: "local",
      capabilities: ExecutionCapabilities(shell: true, browser: true, computer: false)))

  static let health = HealthResponse(
    version: "0.1.0", apiVersion: 1, vaultName: "Test Vault", agentMode: .live)
}
