import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import Foundation

/// Turns agent task records into editor badges anchored to the (possibly locally edited) text.
enum BadgeBuilder {
  /// Pill text for a task's badge; nil = no badge (idle, ignored, unknown statuses).
  static func label(for record: TaskAgentRecord) -> String? {
    let summary = record.summary?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    switch record.status {
    case .triaging: return "Triaging…"
    case .queued: return "Queued"
    case .working: return summary ?? "Working…"
    case .waitingApproval: return "Needs approval"
    case .waitingUser: return "Needs your input"
    case .done: return summary.map { "Done · \($0)" } ?? "Done"
    case .failed: return summary.map { "Failed · \($0)" } ?? "Failed"
    case .cancelled: return "Stopped"
    default: return nil
    }
  }

  /// Badges for `records`, re-resolved against `document` with the daemon's anchor algorithm.
  static func badges(for records: [TaskAgentRecord], in document: String) -> [EditorBadge] {
    let visible = records.compactMap { record in label(for: record).map { (record, $0) } }
    guard !visible.isEmpty else { return [] }
    let anchors = visible.map { TaskAnchor(taskId: $0.0.taskId, text: $0.0.text, line: $0.0.line) }
    let lines = TaskAnchors.resolve(document, anchors: anchors)
    return visible
      .compactMap { record, label in
        lines[record.taskId].map {
          EditorBadge(
            id: record.taskId, line: $0, status: record.status.rawValue, label: label,
            unread: record.unread, threadId: record.threadId)
        }
      }
      .sorted { ($0.line, $0.id) < ($1.line, $1.id) }
  }
}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
