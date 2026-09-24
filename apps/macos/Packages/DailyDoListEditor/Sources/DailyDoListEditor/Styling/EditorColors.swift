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

  // Status tones: the app's theme and the web app's `--ddl-warning`, `--ddl-danger`, ….
  static let warning = tone(light: 0xB7791F, dark: 0xE0A526)
  static let danger = tone(light: 0xD1383D, dark: 0xE5534B)
  static let success = tone(light: 0x2F9E5A, dark: 0x4FB477)
  static let info = tone(light: 0x1F6FEB, dark: 0x4EA1FF)
  /// Vim's search matches (the web app's `.cm-searchMatch`: warning at 25 %).
  static let warningFill = tone(light: 0xB7791F, dark: 0xE0A526, alpha: 0.25)
  /// Vim's command-line panel: the app theme's secondary background and border.
  static let panelBackground = tone(light: 0xF6F6F6, dark: 0x262626)
  static let panelBorder = tone(light: 0xE3E3E3, dark: 0x333333)
  static let panelText = tone(light: 0x222222, dark: 0xDCDDDE)
  static let panelMutedText = tone(light: 0x5C5C5C, dark: 0xA3A3A3)

  // Agent badges (see `BadgeStyle`).
  static let badgeBackground = dynamic(light: NSColor(white: 0, alpha: 0.04), dark: NSColor(white: 1, alpha: 0.07))
  static let badgeHoverBackground = dynamic(light: NSColor(white: 0, alpha: 0.09), dark: NSColor(white: 1, alpha: 0.14))
  static let badgeBorder = dynamic(light: NSColor(white: 0, alpha: 0.12), dark: NSColor(white: 1, alpha: 0.16))
  static let badgeWarningFill = tone(light: 0xB7791F, dark: 0xE0A526, alpha: 0.14)
  static let badgeWarningHoverFill = tone(light: 0xB7791F, dark: 0xE0A526, alpha: 0.22)
  static let badgeDangerFill = tone(light: 0xD1383D, dark: 0xE5534B, alpha: 0.10)
  static let badgeDangerHoverFill = tone(light: 0xD1383D, dark: 0xE5534B, alpha: 0.16)

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

  private static func tone(light: UInt32, dark: UInt32, alpha: CGFloat = 1) -> NSColor {
    dynamic(light: rgb(light, alpha: alpha), dark: rgb(dark, alpha: alpha))
  }
}
