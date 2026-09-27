import DailyDoListModels
import Foundation

/// Sections of the agent inbox, in display order.
public enum InboxGroup: String, CaseIterable, Hashable, Sendable, Identifiable {
  /// Waiting for an approval or an answer.
  case needsYou
  /// Triaging, queued or working.
  case working
  case done
  /// Failed, stopped, ignored, idle, or a status this build doesn't know.
  case other

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .needsYou: "Needs you"
    case .working: "Working"
    case .done: "Done"
    case .other: "Other"
    }
  }

  /// The section of a thread. Any pending approval puts it under "Needs you".
  public static func of(status: TaskAgentStatus, pendingApprovals: Int) -> InboxGroup {
    if pendingApprovals > 0 || status.needsUser { return .needsYou }
    switch status {
    case .triaging, .queued, .working: return .working
    case .done: return .done
    default: return .other
    }
  }
}

/// One non-empty inbox section.
public struct InboxSection: Identifiable, Hashable, Sendable {
  public var group: InboxGroup
  /// Newest first.
  public var threads: [ThreadSummary]

  public var id: InboxGroup { group }

  public init(group: InboxGroup, threads: [ThreadSummary]) {
    self.group = group
    self.threads = threads
  }
}

public enum InboxGrouping {
  /// Today's threads plus older ones that still need the user or are still running, grouped
  /// and newest first (same rules as the web inbox). Empty sections are omitted.
  ///
  /// - Parameter pendingApprovalThreadIds: threads with a locally known pending approval (the
  ///   summary's count can lag behind `approval.upsert`).
  public static func sections(
    for threads: some Sequence<ThreadSummary>, pendingApprovalThreadIds: Set<String> = [],
    now: Date = Date(), calendar: Calendar = .current
  ) -> [InboxSection] {
    var buckets: [InboxGroup: [ThreadSummary]] = [:]
    for thread in threads {
      let pending = pendingApprovalThreadIds.contains(thread.id) ? 1 : thread.pendingApprovals
      let group = InboxGroup.of(status: thread.status, pendingApprovals: pending)
      let recent =
        calendar.isDate(Date(epochMillis: thread.updatedAt), inSameDayAs: now)
        || calendar.isDate(Date(epochMillis: thread.createdAt), inSameDayAs: now)
      guard recent || group == .needsYou || group == .working else { continue }
      buckets[group, default: []].append(thread)
    }
    return InboxGroup.allCases.compactMap { group in
      guard let threads = buckets[group], !threads.isEmpty else { return nil }
      let sorted = threads.sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
      return InboxSection(group: group, threads: sorted)
    }
  }
}
