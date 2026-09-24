import Foundation

/// An agent badge drawn at the end of a task line (or of a line a thread is anchored to).
///
/// Badges aren't part of the text: the editor anchors each one to the start of its line and keeps
/// it there through subsequent edits (lines inserted or deleted above move it; deleting its line
/// drops it) until the host sends fresh badges. `idle` and `ignored` badges are kept but not drawn.
public struct EditorBadge: Hashable, Sendable, Identifiable {
  /// Task id (stable across edits).
  public var id: String
  /// 0-based line.
  public var line: Int
  /// `TaskAgentStatus` raw value (`working`, `waiting_approval`, `done`, …).
  public var status: String
  /// Short pill text, e.g. "Researching…", "Needs approval".
  public var label: String
  public var unread: Int
  public var threadId: String?
  /// The thread is attached to this line rather than to a task on it: the line gets a soft accent
  /// band with a bar at its left edge while the badge is drawn.
  public var highlightsLine: Bool

  public init(
    id: String, line: Int, status: String, label: String, unread: Int = 0, threadId: String? = nil,
    highlightsLine: Bool = false
  ) {
    self.id = id
    self.line = line
    self.status = status
    self.label = label
    self.unread = unread
    self.threadId = threadId
    self.highlightsLine = highlightsLine
  }
}
