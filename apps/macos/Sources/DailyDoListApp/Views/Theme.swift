import AppKit
import SwiftUI

/// Colors and metrics of the shell: the app's palette (the web app's `--ddl-*` tokens in
/// theme.css), dark and light.
enum Theme {
  static let accent = Color(lightHex: 0x1D6FE8, darkHex: 0x3B8BFF)
  /// Hovered and pressed accent.
  static let accentStrong = Color(lightHex: 0x1557C0, darkHex: 0x5CA0FF)
  /// Tinted backgrounds.
  static let accentSoft = Color(lightHex: 0x1D6FE8, darkHex: 0x3B8BFF, lightOpacity: 0.12, darkOpacity: 0.16)
  static let success = Color(lightHex: 0x0F9D58, darkHex: 0x34D399)
  static let warning = Color(lightHex: 0xB7791F, darkHex: 0xFBBF24)
  static let danger = Color(lightHex: 0xD92D20, darkHex: 0xF87171)
  static let info = Color(lightHex: 0x0891B2, darkHex: 0x22D3EE)

  /// The editor, the note and the agent panel.
  static let background = Color(lightHex: 0xFFFFFF, darkHex: 0x0E1116)
  /// The sidebar.
  static let secondaryBackground = Color(lightHex: 0xF3F5F8, darkHex: 0x151A21)
  static let hover = Color(lightHex: 0xE9EDF2, darkHex: 0x1E2530)
  /// Selected rows, the active tab.
  static let activeBackground = Color(lightHex: 0xDDE4EE, darkHex: 0x242D3A)
  static let border = Color(lightHex: 0xD5DCE5, darkHex: 0x283140)
  /// Every line between and inside the panes, opaque so it reads the same on any background.
  static let separator = Color(lightHex: 0xD5DCE5, darkHex: 0x283140)
  static let text = Color(lightHex: 0x0B1220, darkHex: 0xF2F5F9)
  static let mutedText = Color(lightHex: 0x475467, darkHex: 0xB4BDC9)
  static let faintText = Color(lightHex: 0x8492A6, darkHex: 0x7A8594)
  /// Cards, popovers, toasts, code.
  static let elevated = Color(lightHex: 0xFFFFFF, darkHex: 0x1A2029)
  /// The open tab, on the header's background.
  static let selectedTab = Color(lightHex: 0xDDE4EE, darkHex: 0x242D3A)

  /// Every pane's top row (sidebar, tabs, agent panel), so their bottom lines meet.
  static let headerHeight: CGFloat = 40
  static let statusBarHeight: CGFloat = 26
  static let readableWidth: CGFloat = 700
  /// Room the window's close/minimize/zoom buttons need at the top-left (outside full screen).
  static let trafficLightsWidth: CGFloat = 76
}

extension Color {
  /// A color that follows the effective appearance (light/dark).
  init(lightHex light: UInt32, darkHex dark: UInt32, opacity: Double = 1) {
    self.init(lightHex: light, darkHex: dark, lightOpacity: opacity, darkOpacity: opacity)
  }

  /// A color that follows the effective appearance, with an opacity per appearance.
  init(lightHex light: UInt32, darkHex dark: UInt32, lightOpacity: Double, darkOpacity: Double) {
    self.init(
      nsColor: NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return isDark ? NSColor(rgbHex: dark, alpha: darkOpacity) : NSColor(rgbHex: light, alpha: lightOpacity)
      })
  }
}

extension NSColor {
  convenience init(rgbHex hex: UInt32, alpha: Double = 1) {
    self.init(
      srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
  }
}

/// A one-pixel line in ``Theme/separator``: horizontal (full width) or vertical (full height).
struct Hairline: View {
  var axis: Axis = .horizontal
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    let thickness = 1 / max(displayScale, 1)
    Rectangle()
      .fill(Theme.separator)
      .frame(width: axis == .vertical ? thickness : nil, height: axis == .horizontal ? thickness : nil)
      .accessibilityHidden(true)
  }
}

/// Small rounded capsule for counts and states.
struct Pill: View {
  let text: String
  var color: Color = Theme.accent

  var body: some View {
    Text(text)
      .font(.system(size: 10, weight: .semibold))
      .padding(.horizontal, 6)
      .padding(.vertical, 1.5)
      .foregroundStyle(color)
      .background(color.opacity(0.14), in: Capsule())
  }
}

/// Plain icon button with hover highlight: the one control style of every pane header.
struct IconButton: View {
  let systemImage: String
  let help: String
  var isActive = false
  var isEnabled = true
  /// Smaller glyph and hit area, for quiet rows (the daily note navigator).
  var isCompact = false
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: isCompact ? 10 : 13, weight: isCompact ? .semibold : .regular))
        .frame(width: isCompact ? 22 : 28, height: isCompact ? 22 : 28)
        .foregroundStyle(isActive ? Theme.accent : (isEnabled ? Theme.mutedText : Theme.faintText))
        .background(
          RoundedRectangle(cornerRadius: 6)
            .fill(hovering && isEnabled ? Theme.hover : .clear))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!isEnabled)
    .help(help)
    .onHover { hovering = $0 }
    .accessibilityLabel(help)
  }
}
