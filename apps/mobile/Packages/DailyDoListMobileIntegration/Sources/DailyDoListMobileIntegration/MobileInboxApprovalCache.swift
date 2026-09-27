import DailyDoListMobileKit
import DailyDoListModels
import Foundation

/// Reads the same timestamped Inbox used by AgentStore. A background approval refresh uses a
/// generation check and replaces only pending approvals; it cannot refresh unrelated cached ages.
public struct MobileInboxApprovalCache: PhoneApprovalCache {
  private let cache: MobileAgentContentCache

  public init(rootDirectory: URL, scope: WorkspaceScope) throws {
    cache = try MobileAgentContentCache(rootDirectory: rootDirectory, scope: scope)
  }

  public init(cache: MobileAgentContentCache) { self.cache = cache }

  public func snapshot() async throws -> PhoneApprovalSnapshot? {
    guard let saved = try await cache.inbox() else { return nil }
    return PhoneApprovalSnapshot(
      approvals: saved.value.approvals, fetchedAt: saved.value.approvalsFetchedAt,
      generation: saved.metadata.generation)
  }

  public func replacePending(_ approvals: [ApprovalRequest], replacing generation: Int64?)
    async throws
  {
    _ = try await cache.replacePendingApprovals(approvals, replacing: generation)
  }
}
