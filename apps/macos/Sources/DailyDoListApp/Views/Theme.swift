import AppKit
import SwiftUI

/// Colors and metrics of the shell (Obsidian-like; same tokens as the web app's theme.css).
enum Theme {
  static let accent = Color(lightHex: 0x705DCF, darkHex: 0x7F6DF2)
  static let accentSoft = Color(lightHex: 0x705DCF, darkHex: 0x7F6DF2, opacity: 0.14)
  static let success = Color(lightHex: 0x2F9E5A, darkHex: 0x4FB477)
  static let warning = Color(lightHex: 0xB7791F, darkHex: 0xE0A526)
  static let danger = Color(lightHex: 0xD1383D, darkHex: 0xE5534B)
  static let info = Color(lightHex: 0x1F6FEB, darkHex: 0x4EA1FF)

  static let background = Color(lightHex: 0xFFFFFF, darkHex: 0x1E1E1E)
  static let secondaryBackground = Color(lightHex: 0xF6F6F6, darkHex: 0x262626)
  static let hover = Color(lightHex: 0xECECEC, darkHex: 0x2E2E2E)
  static let activeBackground = Color(lightHex: 0xE2E2E2, darkHex: 0x363636)
  static let border = Color(lightHex: 0xE3E3E3, darkHex: 0x333333)
  static let text = Color(lightHex: 0x222222, darkHex: 0xDCDDDE)
  static let mutedText = Color(lightHex: 0x5C5C5C, darkHex: 0xA3A3A3)
  static let faintText = Color(lightHex: 0x9A9A9A, darkHex: 0x666666)
  static let elevated = Color(lightHex: 0xFFFFFF, darkHex: 0x2A2A2A)

  static let tabBarHeight: CGFloat = 36
  static let statusBarHeight: CGFloat = 24
  static let readableWidth: CGFloat = 700
}

extension Color {
  /// A color that follows the effective appearance (light/dark).
  init(lightHex light: UInt32, darkHex dark: UInt32, opacity: Double = 1) {
    self.init(
      nsColor: NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor(rgbHex: isDark ? dark : light, alpha: opacity)
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

/// Plain icon button with hover highlight (toolbar-like controls inside content).
struct IconButton: View {
  let systemImage: String
  let help: String
  var isActive = false
  var isEnabled = true
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: 12, weight: .medium))
        .frame(width: 24, height: 22)
        .foregroundStyle(isActive ? Theme.accent : (isEnabled ? Theme.mutedText : Theme.faintText))
        .background(
          RoundedRectangle(cornerRadius: 5)
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
