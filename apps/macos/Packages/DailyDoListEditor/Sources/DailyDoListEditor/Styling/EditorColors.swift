import AppKit

/// Dynamic colors of the editor (light/dark resolved at draw time).
enum EditorColors {
  /// Obsidian's accent `#7F6DF2`, lighter in dark mode.
  static let accent = dynamic(light: rgb(0x7F6DF2), dark: rgb(0xA497F8))
  static let text = NSColor.textColor
  static let secondaryText = NSColor.secondaryLabelColor
  static let tertiaryText = NSColor.tertiaryLabelColor
  static let linkUnderline = dynamic(light: rgb(0x7F6DF2, alpha: 0.45), dark: rgb(0xA497F8, alpha: 0.5))
  static let codeBackground = dynamic(light: NSColor(white: 0, alpha: 0.055), dark: NSColor(white: 1, alpha: 0.075))
  static let codeBlockBackground = dynamic(light: NSColor(white: 0, alpha: 0.04), dark: NSColor(white: 1, alpha: 0.055))
  static let tagBackground = dynamic(light: rgb(0x7F6DF2, alpha: 0.12), dark: rgb(0xA497F8, alpha: 0.18))
  static let highlightBackground = dynamic(light: rgb(0xFFE45C, alpha: 0.6), dark: rgb(0xE5C542, alpha: 0.32))
  static let quoteBar = dynamic(light: rgb(0x7F6DF2, alpha: 0.75), dark: rgb(0xA497F8, alpha: 0.7))
  static let rule = NSColor.separatorColor
  static let bullet = NSColor.secondaryLabelColor
  static let badgeBackground = dynamic(light: NSColor(white: 0, alpha: 0.04), dark: NSColor(white: 1, alpha: 0.07))
  static let badgeHoverBackground = dynamic(light: NSColor(white: 0, alpha: 0.09), dark: NSColor(white: 1, alpha: 0.14))
  static let badgeBorder = dynamic(light: NSColor(white: 0, alpha: 0.12), dark: NSColor(white: 1, alpha: 0.16))

  static func dynamic(light: NSColor, dark: NSColor) -> NSColor {
    NSColor(name: nil) { appearance in
      appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
    }
  }

  static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
    NSColor(
      srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
  }

  /// Status dot color of an agent badge (`TaskAgentStatus` raw values).
  static func badgeStatus(_ status: String) -> NSColor {
    switch status {
    case "triaging": accent
    case "working": .systemBlue
    case "waiting_approval", "waiting_user": .systemOrange
    case "done": .systemGreen
    case "failed": .systemRed
    default: .systemGray
    }
  }

  /// Border tint of badges that need attention.
  static func badgeBorder(for status: String) -> NSColor {
    switch status {
    case "waiting_approval", "waiting_user": NSColor.systemOrange.withAlphaComponent(0.5)
    case "failed": NSColor.systemRed.withAlphaComponent(0.5)
    default: badgeBorder
    }
  }
}
