import DailyDoListClient
import DailyDoListModels
import Foundation
import Observation

// Public API of the agent package. (Initial stub — replaced by the full store with event
// reduction, streaming deltas, approvals, notifications and commands.)

/// All agent state the UI renders, kept current from REST snapshots + WebSocket events.
@MainActor
@Observable
public final class AgentStore {
  public private(set) var status: AgentStatusResponse?
  /// Task records by note path.
  public private(set) var recordsByNote: [String: [TaskAgentRecord]] = [:]
  /// Thread summaries by id (today's inbox and anything seen since launch).
  public private(set) var threads: [String: ThreadSummary] = [:]
  /// Fully loaded threads (opened in the panel), kept live by events.
  public private(set) var loadedThreads: [String: AgentThread] = [:]
  public private(set) var approvals: [String: ApprovalRequest] = [:]

  public let client: DaemonClient

  public init(client: DaemonClient) {
    self.client = client
  }

  public func records(for notePath: String) -> [TaskAgentRecord] {
    recordsByNote[notePath] ?? []
  }

  public var pendingApprovals: [ApprovalRequest] {
    approvals.values.filter(\.isPending).sorted { $0.createdAt < $1.createdAt }
  }

  /// Applies one server event (called by the app's event loop for every event).
  public func apply(_ event: ServerEvent) {
    switch event {
    case .agentStatus(let status): self.status = status
    case .taskRecords(let e): recordsByNote[e.notePath] = e.records
    case .threadUpsert(let summary): threads[summary.id] = summary
    case .approvalUpsert(let approval): approvals[approval.id] = approval
    default: break
    }
  }

  /// Refetches status, pending approvals and today's threads (startup and after reconnects).
  public func refresh() async {
    if let status = try? await client.agentStatus() { self.status = status }
  }
}
