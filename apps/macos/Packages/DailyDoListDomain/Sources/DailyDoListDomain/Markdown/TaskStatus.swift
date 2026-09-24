/// Task statuses. Beyond Obsidian's `[ ]`/`[x]`, the common "alternate checkbox" conventions:
/// `[/]` in progress, `[-]` cancelled, `[>]` (or `[<]`) deferred/forwarded.
public enum TaskStatus: String, Sendable, Hashable, Codable, CaseIterable {
  case open, done
  case inProgress = "in_progress"
  case cancelled, deferred, other

  /// `statusFromChar`: the status a checkbox character stands for.
  public init(statusChar: String) {
    switch Array(statusChar.utf16) {
    case [0x20]: self = .open
    case [0x78], [0x58]: self = .done
    case [0x2F]: self = .inProgress
    case [0x2D]: self = .cancelled
    case [0x3E], [0x3C]: self = .deferred
    default: self = .other
    }
  }

  /// `charFromStatus`: the canonical checkbox character (`other` writes an open box).
  public var statusChar: String {
    switch self {
    case .open, .other: " "
    case .done: "x"
    case .inProgress: "/"
    case .cancelled: "-"
    case .deferred: ">"
    }
  }

  /// `isClosedStatus`: nothing left to do (done, cancelled, deferred).
  public var isClosed: Bool {
    self == .done || self == .cancelled || self == .deferred
  }
}
