import AppKit
import SwiftUI

/// Semantic color of a status, risk or result (same palette as the web app's `--ddl-*` tokens).
public enum Tone: String, CaseIterable, Hashable, Sendable {
  case accent, faint, info, warning, success, danger

  public var color: Color {
    switch self {
    case .accent: AgentTheme.accent
    case .faint: AgentTheme.faint
    case .info: AgentTheme.info
    case .warning: AgentTheme.warning
    case .success: AgentTheme.success
    case .danger: AgentTheme.danger
    }
  }

  /// Text and icons drawn on a fill of this tone: the dark palette's status tones are too light
  /// for white.
  public var onFillColor: Color {
    switch self {
    case .accent, .faint: .white
    case .info, .warning, .success, .danger: Color(light: 0xFFFFFF, dark: 0x0E1116)
    }
  }
}

/// Colors of the agent UI, adapting to light and dark appearance (the app's palette).
public enum AgentTheme {
  public static let accent = Color(nsColor: AgentPalette.accent)
  public static let accentStrong = Color(nsColor: AgentPalette.accentStrong)
  public static let accentSoft = Color(nsColor: AgentPalette.accentSoft)
  public static let success = Color(light: 0x0F9D58, dark: 0x34D399)
  public static let warning = Color(light: 0xB7791F, dark: 0xFBBF24)
  public static let danger = Color(light: 0xD92D20, dark: 0xF87171)
  public static let info = Color(light: 0x0891B2, dark: 0x22D3EE)
  public static let faint = Color(nsColor: AgentPalette.faintText)
  static let text = Color(nsColor: AgentPalette.text)
  static let mutedText = Color(nsColor: AgentPalette.mutedText)
  /// Code blocks: the elevated surface in dark mode, the secondary background in light mode.
  static let codeBackground = Color(light: 0xF3F5F8, dark: 0x1A2029)
  /// Cards and popovers (`elevated`).
  static let cardBackground = Color(light: 0xFFFFFF, dark: 0x1A2029)
  static let subtleFill = Color(light: 0xF3F5F8, dark: 0x151A21)
  static let hoverFill = Color(light: 0xE9EDF2, dark: 0x1E2530)
  /// The chosen tab of a row of chips (the app's open-tab color).
  static let selectedFill = Color(light: 0xDDE4EE, dark: 0x242D3A)
  /// Lines and outlines; the same color as the app's pane separators.
  static let border = Color(light: 0xD5DCE5, dark: 0x283140)
  static let panelBackground = Color(light: 0xFFFFFF, dark: 0x0E1116)
}

/// The palette colors AppKit views draw with.
enum AgentPalette {
  static let accent = NSColor(light: 0x1D6FE8, dark: 0x3B8BFF)
  static let accentStrong = NSColor(light: 0x1557C0, dark: 0x5CA0FF)
  static let accentSoft = NSColor(light: 0x1D6FE8, dark: 0x3B8BFF, lightAlpha: 0.12, darkAlpha: 0.16)
  static let text = NSColor(light: 0x0B1220, dark: 0xF2F5F9)
  static let mutedText = NSColor(light: 0x475467, dark: 0xB4BDC9)
  static let faintText = NSColor(light: 0x8492A6, dark: 0x7A8594)
}

extension Color {
  /// A color that resolves per appearance (hex RGB).
  init(light: UInt32, dark: UInt32) {
    self.init(nsColor: NSColor(light: light, dark: dark))
  }
}

extension NSColor {
  convenience init(rgb: UInt32, alpha: CGFloat = 1) {
    self.init(
      srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255, alpha: alpha)
  }

  /// A color that resolves per appearance (hex RGB, optional alpha per appearance).
  convenience init(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) {
    self.init(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      return isDark ? NSColor(rgb: dark, alpha: darkAlpha) : NSColor(rgb: light, alpha: lightAlpha)
    }
  }
}
