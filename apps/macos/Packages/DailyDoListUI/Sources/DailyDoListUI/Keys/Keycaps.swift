import SwiftUI

/// A shortcut as keycaps, one per key: [⇧][⌘][D]. The one way shortcuts are drawn (tooltips, the
/// palette, the quick switcher, settings, the menu bar window); the native menu bar keeps its own.
public struct Keycaps: View {
  let caps: [String]
  let spoken: String

  public init(_ shortcut: KeyShortcut) {
    caps = shortcut.caps
    spoken = shortcut.spokenDescription
  }

  /// Several single keys side by side ([↑][↓]), read as "Up Arrow, Down Arrow".
  public init(_ shortcuts: [KeyShortcut]) {
    caps = shortcuts.flatMap(\.caps)
    spoken = shortcuts.map(\.spokenDescription).joined(separator: ", ")
  }

  public var body: some View {
    HStack(spacing: Keycap.spacing) {
      ForEach(Array(caps.enumerated()), id: \.offset) { _, cap in
        Keycap(text: cap)
      }
    }
    .fixedSize()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken)
  }
}

/// One key: 11 pt medium in the muted text color on a faint rounded fill with a hairline border.
struct Keycap: View {
  let text: String

  /// Between two caps.
  static let spacing: CGFloat = 2
  static let height: CGFloat = 16

  var body: some View {
    Text(verbatim: text)
      .font(.system(size: 11, weight: .medium))
      .foregroundStyle(Theme.mutedText)
      .lineLimit(1)
      .padding(.horizontal, 4)
      .frame(minWidth: 16, minHeight: Self.height, maxHeight: Self.height)
      .background(RoundedRectangle(cornerRadius: 4).fill(Theme.Keycap.fill))
      .overlay(
        RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.Keycap.border, lineWidth: 1))
  }
}
