import AppKit

/// Dynamic colors of the editor (light/dark resolved at draw time), from the app's palette (the
/// web app's `--ddl-*` tokens).
enum EditorColors {
  // MARK: Palette

  static let background = tone(light: 0xFFFFFF, dark: 0x0E1116)
  static let secondaryBackground = tone(light: 0xF3F5F8, dark: 0x151A21)
  static let elevated = tone(light: 0xFFFFFF, dark: 0x1A2029)
  static let hover = tone(light: 0xE9EDF2, dark: 0x1E2530)
  static let selected = tone(light: 0xDDE4EE, dark: 0x242D3A)
  static let separator = tone(light: 0xD5DCE5, dark: 0x283140)
  static let text = tone(light: 0x0B1220, dark: 0xF2F5F9)
  /// The palette's `mutedText`.
  static let secondaryText = tone(light: 0x475467, dark: 0xB4BDC9)
  /// The palette's `faintText`.
  static let tertiaryText = tone(light: 0x8492A6, dark: 0x7A8594)
  static let accent = tone(light: 0x1D6FE8, dark: 0x3B8BFF)
  static let accentStrong = tone(light: 0x1557C0, dark: 0x5CA0FF)
  static let accentSoft = dynamic(
    light: rgb(0x1D6FE8, alpha: 0.12), dark: rgb(0x3B8BFF, alpha: 0.16))
  /// Text the agent wrote into the note.
  static let agentText = tone(light: 0x1D5FC4, dark: 0x8CC2FF)
  /// The band behind a line a thread is anchored to.
  static let anchorBackground = dynamic(
    light: rgb(0x1D6FE8, alpha: 0.08), dark: rgb(0x3B8BFF, alpha: 0.10))
  static let success = tone(light: 0x0F9D58, dark: 0x34D399)
  static let warning = tone(light: 0xB7791F, dark: 0xFBBF24)
  static let danger = tone(light: 0xD92D20, dark: 0xF87171)
  static let info = tone(light: 0x0891B2, dark: 0x22D3EE)

  // MARK: Text

  static let selection = dynamic(
    light: rgb(0x1D6FE8, alpha: 0.22), dark: rgb(0x3B8BFF, alpha: 0.32))
  static let linkUnderline = dynamic(
    light: rgb(0x1D6FE8, alpha: 0.45), dark: rgb(0x3B8BFF, alpha: 0.55))
  static let codeBackground = hover
  static let codeBlockBackground = dynamic(light: rgb(0xF3F5F8), dark: rgb(0x1A2029))
  static let tagBackground = accentSoft
  static let highlightBackground = dynamic(
    light: rgb(0xFFE45C, alpha: 0.6), dark: rgb(0xE5C542, alpha: 0.32))
  static let quoteBar = dynamic(light: rgb(0x1D6FE8, alpha: 0.75), dark: rgb(0x3B8BFF, alpha: 0.75))
  static let rule = separator
  static let bullet = secondaryText
  static let lineNumber = tertiaryText
  static let currentLineNumber = secondaryText

  /// Vim's search matches (the web app's `.cm-searchMatch`: warning at 25 %).
  static let warningFill = dynamic(
    light: rgb(0xB7791F, alpha: 0.25), dark: rgb(0xFBBF24, alpha: 0.25))
  /// Vim's command-line panel.
  static let panelBackground = secondaryBackground
  static let panelBorder = separator
  static let panelText = text
  static let panelMutedText = secondaryText

  // MARK: Agent badges (see `BadgeStyle`)

  static let badgeBackground = dynamic(light: rgb(0xF3F5F8), dark: rgb(0x1A2029))
  static let badgeHoverBackground = hover
  static let badgeBorder = separator
  static let badgeWarningFill = dynamic(
    light: rgb(0xB7791F, alpha: 0.14), dark: rgb(0xFBBF24, alpha: 0.14))
  static let badgeWarningHoverFill = dynamic(
    light: rgb(0xB7791F, alpha: 0.22), dark: rgb(0xFBBF24, alpha: 0.22))
  static let badgeDangerFill = dynamic(
    light: rgb(0xD92D20, alpha: 0.10), dark: rgb(0xF87171, alpha: 0.10))
  static let badgeDangerHoverFill = dynamic(
    light: rgb(0xD92D20, alpha: 0.16), dark: rgb(0xF87171, alpha: 0.16))

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

  private static func tone(light: UInt32, dark: UInt32) -> NSColor {
    dynamic(light: rgb(light), dark: rgb(dark))
  }
}
