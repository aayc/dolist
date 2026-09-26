import SwiftUI

/// A disclosure whose whole label row toggles it: a chevron that turns (unless Reduce Motion is
/// on), the label brightening under the pointer, and the pointing hand. The content isn't part of
/// the control, so selectable text in it keeps its I-beam.
public struct ChevronDisclosureStyle: DisclosureGroupStyle {
  public init() {}

  public func makeBody(configuration: Configuration) -> some View {
    ChevronDisclosure(configuration: configuration)
  }
}

private struct ChevronDisclosure: View {
  let configuration: DisclosureGroupStyleConfiguration
  @State private var hovering = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.18)) {
          configuration.isExpanded.toggle()
        }
      } label: {
        HStack(spacing: 5) {
          Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .rotationEffect(.degrees(configuration.isExpanded ? 90 : 0))
            .frame(width: 10)
          configuration.label
        }
        .foregroundStyle(hovering ? Theme.text : Theme.mutedText)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .onHover { hovering = $0 }
      .pointingHandCursor()
      .animation(.easeOut(duration: ControlState.hoverDuration), value: hovering)
      .accessibilityAddTraits(configuration.isExpanded ? .isSelected : [])
      if configuration.isExpanded {
        configuration.content
      }
    }
  }
}
