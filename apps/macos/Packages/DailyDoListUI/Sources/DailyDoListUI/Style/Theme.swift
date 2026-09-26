import AppKit
import SwiftUI

/// The app's palette (the web app's `--ddl-*` tokens in theme.css), dark and light: the one source
/// of the shell's, the agent UI's and the editor's colors. AppKit code takes `NSColor(Theme.accent)`,
/// the same dynamic color.
public enum Theme {
  public static let accent = Color(light: 0x1D6FE8, dark: 0x3B8BFF)
  /// Hovered and pressed accent.
  public static let accentStrong = Color(light: 0x1557C0, dark: 0x5CA0FF)
  /// Tinted backgrounds.
  public static let accentSoft = Color(nsColor: NSColor(accent).opacity(light: 0.12, dark: 0.16))
  public static let success = Color(light: 0x0F9D58, dark: 0x34D399)
  public static let warning = Color(light: 0xB7791F, dark: 0xFBBF24)
  public static let danger = Color(light: 0xD92D20, dark: 0xF87171)
  public static let info = Color(light: 0x0891B2, dark: 0x22D3EE)

  /// The editor, the note and the agent panel.
  public static let background = Color(light: 0xFFFFFF, dark: 0x0E1116)
  /// The sidebar.
  public static let secondaryBackground = Color(light: 0xF3F5F8, dark: 0x151A21)
  /// Cards, popovers, toasts.
  public static let elevated = Color(light: 0xFFFFFF, dark: 0x1A2029)
  /// Code blocks and badges: the secondary background in light mode, the elevated one in dark.
  public static let codeBackground = Color(light: 0xF3F5F8, dark: 0x1A2029)
  /// Under the pointer.
  public static let hover = Color(light: 0xE9EDF2, dark: 0x1E2530)
  /// Pressed, and the selected tab or chip.
  public static let pressed = Color(light: 0xDDE4EE, dark: 0x242D3A)
  /// Every line between and inside the panes, and outlines: opaque, so it reads the same on any
  /// background.
  public static let separator = Color(light: 0xD5DCE5, dark: 0x283140)
  public static let text = Color(light: 0x0B1220, dark: 0xF2F5F9)
  public static let mutedText = Color(light: 0x475467, dark: 0xB4BDC9)
  public static let faintText = Color(light: 0x8492A6, dark: 0x7A8594)

  /// The tooltip is the dark palette's overlay in both appearances.
  enum Tooltip {
    static let surface = dark(elevated)
    static let border = dark(separator)
    static let text = dark(Theme.text)
    static let detail = dark(mutedText)

    private static func dark(_ color: Color) -> Color {
      Color(nsColor: NSColor(color).resolved(in: NSAppearance(named: .darkAqua)!))
    }
  }

  /// Keycaps: a faint fill and outline that work on any surface of their appearance.
  enum Keycap {
    static let fill = Color(
      nsColor: NSColor(light: 0x000000, dark: 0xFFFFFF, lightAlpha: 0.05, darkAlpha: 0.08))
    static let border = Color(
      nsColor: NSColor(light: 0x000000, dark: 0xFFFFFF, lightAlpha: 0.10, darkAlpha: 0.10))
  }
}

/// A one-pixel line in ``Theme/separator``: horizontal (full width) or vertical (full height).
public struct Hairline: View {
  var axis: Axis
  @Environment(\.displayScale) private var displayScale

  public init(axis: Axis = .horizontal) {
    self.axis = axis
  }

  public var body: some View {
    let thickness = 1 / max(displayScale, 1)
    Rectangle()
      .fill(Theme.separator)
      .frame(
        width: axis == .vertical ? thickness : nil, height: axis == .horizontal ? thickness : nil
      )
      .accessibilityHidden(true)
  }
}

extension Color {
  init(light: UInt32, dark: UInt32) {
    self.init(nsColor: NSColor(light: light, dark: dark))
  }
}

extension NSColor {
  /// A color that resolves per appearance (hex RGB, optional alpha per appearance).
  public convenience init(
    light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1
  ) {
    self.init(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      return isDark ? NSColor(rgb: dark, alpha: darkAlpha) : NSColor(rgb: light, alpha: lightAlpha)
    }
  }

  public convenience init(rgb: UInt32, alpha: CGFloat = 1) {
    self.init(
      srgbRed: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
      blue: CGFloat(rgb & 0xFF) / 255, alpha: alpha)
  }

  /// This (dynamic) color at an opacity per appearance.
  public func opacity(light: CGFloat, dark: CGFloat) -> NSColor {
    NSColor(name: nil) { appearance in
      let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      return self.resolved(in: appearance).withAlphaComponent(isDark ? dark : light)
    }
  }

  /// This color as `appearance` draws it.
  func resolved(in appearance: NSAppearance) -> NSColor {
    var color = self
    appearance.performAsCurrentDrawingAppearance { color = self.usingColorSpace(.sRGB) ?? self }
    return color
  }
}
