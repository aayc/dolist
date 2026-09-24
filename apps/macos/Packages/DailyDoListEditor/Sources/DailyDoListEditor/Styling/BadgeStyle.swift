import AppKit

/// How loud an agent badge is. Only badges that need the user stand out; work in progress is a
/// neutral pill and finished work is quiet text.
enum BadgeTier: Equatable, Sendable {
  /// `waiting_approval`, `waiting_user`: warning-tinted pill with a warning border, primary text.
  case needsYou
  /// `failed`: danger text and dot on a faint danger fill, no border.
  case failed
  /// `triaging`, `queued`, `working`: subtle surface fill, hairline border, secondary text.
  case working
  /// `done`, `cancelled` and statuses this build doesn't know: no fill, no border, tertiary text.
  case quiet

  init(status: String) {
    switch status {
    case "waiting_approval", "waiting_user": self = .needsYou
    case "failed": self = .failed
    case "triaging", "queued", "working": self = .working
    default: self = .quiet
    }
  }
}

/// Colors of one badge (dynamic: light/dark resolve at draw time). Hovering strengthens the fill
/// (quiet badges get a subtle one) and brings neutral text forward.
struct BadgeStyle {
  var fill: NSColor?
  var border: NSColor?
  var text: NSColor
  var dot: NSColor

  init(status: String, isHovered: Bool) {
    dot = Self.dotColor(status)
    switch BadgeTier(status: status) {
    case .needsYou:
      fill = isHovered ? EditorColors.badgeWarningHoverFill : EditorColors.badgeWarningFill
      border = EditorColors.warning
      text = EditorColors.text
    case .failed:
      fill = isHovered ? EditorColors.badgeDangerHoverFill : EditorColors.badgeDangerFill
      border = nil
      text = EditorColors.danger
    case .working:
      fill = isHovered ? EditorColors.badgeHoverBackground : EditorColors.badgeBackground
      border = EditorColors.badgeBorder
      text = isHovered ? EditorColors.text : EditorColors.secondaryText
    case .quiet:
      fill = isHovered ? EditorColors.badgeHoverBackground : nil
      border = nil
      text = isHovered ? EditorColors.text : EditorColors.tertiaryText
    }
  }

  /// Status dot: triaging accent, working info, needs you warning, done success, failed danger;
  /// queued, cancelled and unknown statuses faint.
  static func dotColor(_ status: String) -> NSColor {
    switch status {
    case "triaging": EditorColors.accent
    case "working": EditorColors.info
    case "waiting_approval", "waiting_user": EditorColors.warning
    case "done": EditorColors.success
    case "failed": EditorColors.danger
    default: EditorColors.tertiaryText
    }
  }
}
