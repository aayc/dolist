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

  /// Text and icons drawn on a fill of this tone (amber is too light for white in dark mode).
  public var onFillColor: Color {
    self == .warning ? Color(light: 0xFFFFFF, dark: 0x1E1E1E) : .white
  }
}

/// Colors of the agent UI, adapting to light and dark appearance.
public enum AgentTheme {
  /// Obsidian purple (#7F6DF2; a shade darker on light backgrounds for contrast).
  public static let accent = Color(light: 0x705DCF, dark: 0x7F6DF2)
  public static let success = Color(light: 0x2F9E5A, dark: 0x4FB477)
  public static let warning = Color(light: 0xB7791F, dark: 0xE0A526)
  public static let danger = Color(light: 0xD1383D, dark: 0xE5534B)
  public static let info = Color(light: 0x1F6FEB, dark: 0x4EA1FF)
  public static let faint = Color(light: 0x8E8E8E, dark: 0x7A7A7A)
  static let codeBackground = Color(light: 0xF3F3F3, dark: 0x171717)
  static let cardBackground = Color(light: 0xFFFFFF, dark: 0x262626)
  static let subtleFill = Color(light: 0xF6F6F6, dark: 0x2A2A2A)
  static let hoverFill = Color(light: 0xECECEC, dark: 0x2E2E2E)
  static let border = Color(light: 0xE3E3E3, dark: 0x363636)
  static let panelBackground = Color(light: 0xFFFFFF, dark: 0x1E1E1E)
}

extension Color {
  /// A color that resolves per appearance (hex RGB).
  init(light: UInt32, dark: UInt32) {
    self.init(
      nsColor: NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor(rgb: isDark ? dark : light)
      })
  }
}

extension NSColor {
  convenience init(rgb: UInt32) {
    self.init(
      srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
  }
}
