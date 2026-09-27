import Foundation

/// An agent badge drawn at the end of a task line (or of a line a thread is anchored to), or one
/// of the orchestrator's chips at the end of a line that woke it.
///
/// Badges aren't part of the text: the editor anchors each one to the start of its line and keeps
/// it there through subsequent edits (lines inserted or deleted above move it; deleting its line
/// drops it) until the host sends fresh badges. `idle` and `ignored` badges are kept but not drawn.
public struct EditorBadge: Hashable, Sendable, Identifiable {
  /// Task id (stable across edits).
  public var id: String
  /// 0-based line.
  public var line: Int
  /// `TaskAgentStatus` raw value (`working`, `waiting_approval`, `done`, …), or one of
  /// ``OrchestratorStatus`` for a chip.
  public var status: String
  /// Short pill text, e.g. "Researching…", "Needs approval". Empty draws just the status dot.
  public var label: String
  public var unread: Int
  public var threadId: String?
  /// The thread is attached to this line rather than to a task on it: the line gets a soft accent
  /// band with a bar at its left edge while the badge is drawn.
  public var highlightsLine: Bool
  /// The tooltip, when it isn't the label (and the unread count).
  public var tooltip: String?
  /// The line's text the badge belongs to: an edit that leaves its line unrecognizable
  /// (``EditorLineMatch/recognizes(_:_:)``) drops the badge. Nil: edits inside the line keep it.
  public var anchorText: String?
  /// The badge fades out (at once with Reduce Motion) and stays invisible until the host removes
  /// it; it takes no clicks and shows no tooltip meanwhile.
  public var isFading: Bool

  public init(
    id: String, line: Int, status: String, label: String, unread: Int = 0, threadId: String? = nil,
    highlightsLine: Bool = false, tooltip: String? = nil, anchorText: String? = nil,
    isFading: Bool = false
  ) {
    self.id = id
    self.line = line
    self.status = status
    self.label = label
    self.unread = unread
    self.threadId = threadId
    self.highlightsLine = highlightsLine
    self.tooltip = tooltip
    self.anchorText = anchorText
    self.isFading = isFading
  }

  /// Statuses of the orchestrator's chips (what it's doing about the line), styled like the
  /// task badges: a quiet pulsing dot when it noticed the line, a neutral pill with a pulsing
  /// dot while it looks, a neutral pill while it acts, then the outcome as quiet text (a warning
  /// pill when it needs the user).
  public enum OrchestratorStatus {
    public static let noticed = "orchestrator.noticed"
    public static let looking = "orchestrator.looking"
    public static let acting = "orchestrator.acting"
    public static let done = "orchestrator.done"
    public static let needsYou = "orchestrator.needs_you"
    public static let nothing = "orchestrator.nothing"
  }
}
