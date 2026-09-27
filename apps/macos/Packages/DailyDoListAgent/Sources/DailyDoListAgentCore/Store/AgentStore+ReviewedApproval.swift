import DailyDoListModels
import Foundation

extension AgentStore {
  /// A phone approval is valid only for the exact card the user reviewed, while connected to
  /// its workspace. It is never queued for later delivery. The broker remains authoritative.
  @discardableResult
  public func decideReviewedApproval(
    _ reviewed: ApprovalRequest, decision: ApprovalDecision, scope: ApprovalScope = .once,
    note: String? = nil, reviewedRunner: AgentRunsOn?, authorizationAvailable: Bool
  ) async -> Bool {
    guard authorizationAvailable, readOnly == nil else {
      lastError = AgentAlert(
        title: "Decision not sent", message: readOnly?.reason ?? "Reconnect to review this action.")
      return false
    }
    guard placement?.runsOn == reviewedRunner,
      let current = approvals[reviewed.id], current == reviewed, current.isPending,
      current.expiresAt.map({ $0 > now().epochMillis }) ?? true
    else {
      lastError = AgentAlert(
        title: "Review the updated action",
        message: "This approval changed or expired. Refresh it before deciding.")
      return false
    }
    return await decide(reviewed.id, decision, scope: scope, note: note)
  }
}
