import AppKit
import DailyDoListUI
import SwiftUI

/// Dynamic colors of the editor (light/dark resolved at draw time), from the app's palette
/// (`DailyDoListUI`'s `Theme`).
enum EditorColors {
  // MARK: Palette

  static let background = NSColor(Theme.background)
  static let secondaryBackground = NSColor(Theme.secondaryBackground)
  static let elevated = NSColor(Theme.elevated)
  static let hover = NSColor(Theme.hover)
  static let selected = NSColor(Theme.pressed)
  static let separator = NSColor(Theme.separator)
  static let text = NSColor(Theme.text)
  static let secondaryText = NSColor(Theme.mutedText)
  static let tertiaryText = NSColor(Theme.faintText)
  static let accent = NSColor(Theme.accent)
  static let accentStrong = NSColor(Theme.accentStrong)
  static let accentSoft = NSColor(Theme.accentSoft)
  /// Text the agent wrote into the note.
  static let agentText = NSColor(light: 0x1D5FC4, dark: 0x8CC2FF)
  /// The band behind a line a thread is anchored to.
  static let anchorBackground = accent.opacity(light: 0.08, dark: 0.10)
  static let success = NSColor(Theme.success)
  static let warning = NSColor(Theme.warning)
  static let danger = NSColor(Theme.danger)
  static let info = NSColor(Theme.info)

  // MARK: Text

  static let selection = accent.opacity(light: 0.22, dark: 0.32)
  static let linkUnderline = accent.opacity(light: 0.45, dark: 0.55)
  static let codeBackground = hover
  static let codeBlockBackground = NSColor(Theme.codeBackground)
  static let tagBackground = accentSoft
  static let highlightBackground = NSColor(
    light: 0xFFE45C, dark: 0xE5C542, lightAlpha: 0.6, darkAlpha: 0.32)
  static let quoteBar = accent.opacity(light: 0.75, dark: 0.75)
  static let rule = separator
  static let bullet = secondaryText
  static let lineNumber = tertiaryText
  static let currentLineNumber = secondaryText

  /// Vim's search matches (the web app's `.cm-searchMatch`: warning at 25 %).
  static let warningFill = warning.opacity(light: 0.25, dark: 0.25)
  /// Vim's command-line panel.
  static let panelBackground = secondaryBackground
  static let panelBorder = separator
  static let panelText = text
  static let panelMutedText = secondaryText

  // MARK: Agent badges (see `BadgeStyle`)

  static let badgeBackground = codeBlockBackground
  static let badgeHoverBackground = hover
  static let badgeBorder = separator
  static let badgeWarningFill = warning.opacity(light: 0.14, dark: 0.14)
  static let badgeWarningHoverFill = warning.opacity(light: 0.22, dark: 0.22)
  static let badgeDangerFill = danger.opacity(light: 0.10, dark: 0.10)
  static let badgeDangerHoverFill = danger.opacity(light: 0.16, dark: 0.16)
}
