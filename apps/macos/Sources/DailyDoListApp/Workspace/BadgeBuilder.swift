import DailyDoListDomain
import DailyDoListEditor
import DailyDoListModels
import Foundation

/// Turns agent records into editor badges anchored to the (possibly locally edited) text: task
/// records on their task's line, line-anchor records on their line (which the editor highlights).
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

  /// Badges for `records`, re-resolved against `document` with the daemon's anchor algorithms.
  /// A line anchor that no longer resolves gets no badge.
  static func badges(for records: [TaskAgentRecord], in document: String) -> [EditorBadge] {
    let visible = records.compactMap { record in label(for: record).map { (record, $0) } }
    guard !visible.isEmpty else { return [] }
    let tasks = visible.filter { $0.0.anchor != .line }
    let anchored = visible.filter { $0.0.anchor == .line }
    let taskLines =
      tasks.isEmpty
      ? [:] : TaskAnchors.resolve(document, anchors: tasks.map { TaskAnchor(record: $0.0) })
    let anchorLines =
      anchored.isEmpty
      ? [:] : LineAnchors.resolve(document, anchors: anchored.map { LineAnchor(record: $0.0) })
    func badge(_ record: TaskAgentRecord, _ label: String, line: Int?) -> EditorBadge? {
      line.map {
        EditorBadge(
          id: record.taskId, line: $0, status: record.status.rawValue, label: label,
          unread: record.unread,
          threadId: record.threadId, highlightsLine: record.anchor == .line)
      }
    }
    return
      (tasks.compactMap { badge($0, $1, line: taskLines[$0.taskId]) }
      + anchored.compactMap { badge($0, $1, line: anchorLines[$0.taskId]?.line) })
      .sorted { ($0.line, $0.id) < ($1.line, $1.id) }
  }

  /// The current line of a record's task or anchored line in `document`, if it's still there.
  static func line(of record: TaskAgentRecord, in document: String) -> Int? {
    if record.anchor == .line {
      return LineAnchors.resolve(document, anchors: [LineAnchor(record: record)])[record.taskId]?
        .line
    }
    return TaskAnchors.resolve(document, anchors: [TaskAnchor(record: record)])[record.taskId]
  }
}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
