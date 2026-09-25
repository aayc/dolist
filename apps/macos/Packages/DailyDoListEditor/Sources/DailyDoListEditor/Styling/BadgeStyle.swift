import AppKit

/// How loud an agent badge is. Only badges that need the user stand out; work in progress is a
/// neutral pill and finished work is quiet text.
enum BadgeTier: Equatable, Sendable {
  /// `waiting_approval`, `waiting_user`, a chip asking for approval: warning-tinted pill with a
  /// warning border, primary text.
  case needsYou
  /// `failed`: danger text and dot on a faint danger fill, no border.
  case failed
  /// `triaging`, `queued`, `working`, a chip while the orchestrator looks or acts: subtle surface
  /// fill, hairline border, secondary text.
  case working
  /// `done`, `cancelled`, the other chips and statuses this build doesn't know: no fill, no
  /// border, tertiary text.
  case quiet

  init(status: String) {
    typealias Chip = EditorBadge.OrchestratorStatus
    switch status {
    case "waiting_approval", "waiting_user", Chip.needsYou: self = .needsYou
    case "failed": self = .failed
    case "triaging", "queued", "working", Chip.looking, Chip.acting: self = .working
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

  /// Status dot: triaging (and a chip noticing or looking) accent, working (and acting) info,
  /// needs you warning, done green, failed danger; queued, cancelled, "nothing to do" and unknown
  /// statuses faint.
  static func dotColor(_ status: String) -> NSColor {
    typealias Chip = EditorBadge.OrchestratorStatus
    switch status {
    case "triaging", Chip.noticed, Chip.looking: return EditorColors.accent
    case "working", Chip.acting: return EditorColors.info
    case "waiting_approval", "waiting_user", Chip.needsYou: return EditorColors.warning
    case "done", Chip.done: return EditorColors.success
    case "failed": return EditorColors.danger
    default: return EditorColors.tertiaryText
    }
  }
}
