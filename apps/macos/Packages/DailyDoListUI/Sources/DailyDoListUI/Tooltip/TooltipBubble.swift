import SwiftUI

/// The tooltip's look: 12 pt text (and keycaps) on the dark elevated surface with a hairline
/// border, 5×8 padding, 6 pt corners and a soft shadow; at most 280 pt wide, wrapping.
public struct TooltipBubble: View {
  let content: TooltipContent

  public init(content: TooltipContent) {
    self.content = content
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      ForEach(Array(content.lines.enumerated()), id: \.offset) { _, line in
        HStack(alignment: .center, spacing: 8) {
          Text(verbatim: line.text)
            .font(.system(size: 12))
            .foregroundStyle(Theme.Tooltip.text)
            .fixedSize(horizontal: false, vertical: true)
          if let keys = line.keys { Keycaps(keys) }
        }
      }
      if let detail = content.detail {
        Text(verbatim: detail)
          .font(.system(size: 11))
          .foregroundStyle(Theme.Tooltip.detail)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(
      RoundedRectangle(cornerRadius: 6)
        .fill(Theme.Tooltip.surface)
        .shadow(color: .black.opacity(0.35), radius: 6, y: 4)
    )
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.Tooltip.border, lineWidth: 1))
    .environment(\.colorScheme, .dark)
    .accessibilityHidden(true)
  }
}

/// The bubble with room around it for its shadow: what the tooltip panel hosts.
struct TooltipPanelContent: View {
  let content: TooltipContent

  /// The shadow's reach (4 pt down, 6 pt blur), so the panel doesn't clip it.
  static let shadowInsets = NSEdgeInsets(top: 10, left: 14, bottom: 18, right: 14)

  var body: some View {
    TooltipBubble(content: content)
      .padding(
        EdgeInsets(
          top: Self.shadowInsets.top, leading: Self.shadowInsets.left,
          bottom: Self.shadowInsets.bottom, trailing: Self.shadowInsets.right))
  }
}
