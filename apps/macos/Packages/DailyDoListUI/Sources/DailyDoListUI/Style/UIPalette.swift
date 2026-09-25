import AppKit
import SwiftUI

/// The colors the shared controls draw with: the app's palette (the web app's `--ddl-*` tokens),
/// dark and light. The shell's `Theme` and the agent UI's `AgentTheme` use the same values.
public enum UIPalette {
  public static let accent = Color(nsColor: NSColor(light: 0x1D6FE8, dark: 0x3B8BFF))
  public static let text = Color(nsColor: NSColor(light: 0x0B1220, dark: 0xF2F5F9))
  public static let mutedText = Color(nsColor: NSColor(light: 0x475467, dark: 0xB4BDC9))
  public static let faintText = Color(nsColor: NSColor(light: 0x8492A6, dark: 0x7A8594))
  /// Under the pointer.
  public static let hover = Color(nsColor: NSColor(light: 0xE9EDF2, dark: 0x1E2530))
  /// Pressed, and the selected tab or chip.
  public static let pressed = Color(nsColor: NSColor(light: 0xDDE4EE, dark: 0x242D3A))
  /// Hairlines and outlines.
  public static let separator = Color(nsColor: NSColor(light: 0xD5DCE5, dark: 0x283140))

  /// The tooltip is the same dark overlay in both appearances.
  enum Tooltip {
    static let surface = Color(nsColor: NSColor(rgb: 0x1A2029))
    static let border = Color(nsColor: NSColor(rgb: 0x283140))
    static let text = Color(nsColor: NSColor(rgb: 0xF2F5F9))
    static let detail = Color(nsColor: NSColor(rgb: 0xB4BDC9))
  }

  /// Keycaps: a faint fill and outline that work on any surface of their appearance.
  enum Keycap {
    static let fill = Color(
      nsColor: NSColor(light: 0x000000, dark: 0xFFFFFF, lightAlpha: 0.05, darkAlpha: 0.08))
    static let border = Color(
      nsColor: NSColor(light: 0x000000, dark: 0xFFFFFF, lightAlpha: 0.10, darkAlpha: 0.10))
  }
}

extension NSColor {
  /// A color that resolves per appearance (hex RGB, optional alpha per appearance).
  convenience init(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) {
    self.init(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      return isDark ? NSColor(rgb: dark, alpha: darkAlpha) : NSColor(rgb: light, alpha: lightAlpha)
    }
  }

  convenience init(rgb: UInt32, alpha: CGFloat = 1) {
    self.init(
      srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255, alpha: alpha)
  }
}
