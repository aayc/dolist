import SwiftUI

/// The button of a view's main action ("Set Up…", "Relaunch Now"): a white label on the accent, a
/// shade stronger under the pointer, a touch smaller while pressed, the pointing hand, and 40%
/// when disabled. Unlike `.borderedProminent` it looks the same whether or not its window is key,
/// so it also works in panels that never take the focus.
public struct AccentButtonStyle: ButtonStyle {
  let horizontalPadding: CGFloat
  let verticalPadding: CGFloat
  let cornerRadius: CGFloat

  public init(
    horizontalPadding: CGFloat = 12, verticalPadding: CGFloat = 5, cornerRadius: CGFloat = 6
  ) {
    self.horizontalPadding = horizontalPadding
    self.verticalPadding = verticalPadding
    self.cornerRadius = cornerRadius
  }

  public func makeBody(configuration: Configuration) -> some View {
    AccentButtonBody(configuration: configuration, style: self)
  }
}

private struct AccentButtonBody: View {
  let configuration: ButtonStyleConfiguration
  let style: AccentButtonStyle
  @State private var hovering = false
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    AccentButtonFace(
      style: style,
      state: ControlState(
        isHovered: hovering, isPressed: configuration.isPressed, isEnabled: isEnabled)
    ) {
      configuration.label
    }
    .onHover { hovering = $0 }
    .pointingHandCursor()
    .animation(.easeOut(duration: ControlState.hoverDuration), value: hovering)
    .animation(.easeOut(duration: ControlState.pressDuration), value: configuration.isPressed)
  }
}

/// An accent button in a given state (also rendered directly by the snapshot tests).
struct AccentButtonFace<Label: View>: View {
  let style: AccentButtonStyle
  let state: ControlState
  @ViewBuilder let label: Label

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: style.cornerRadius, style: .continuous)
    label
      .foregroundStyle(.white)
      .padding(.horizontal, style.horizontalPadding)
      .padding(.vertical, style.verticalPadding)
      .background(shape.fill(state.accentFill))
      .contentShape(shape)
      .scaleEffect(state.isPressed && state.isEnabled ? 0.97 : 1)
      .opacity(state.isEnabled ? 1 : ControlState.disabledOpacity)
  }
}

extension ControlState {
  /// The accent button's fill.
  var accentFill: Color {
    isEnabled && (isHovered || isPressed) ? UIPalette.accentStrong : UIPalette.accent
  }
}
