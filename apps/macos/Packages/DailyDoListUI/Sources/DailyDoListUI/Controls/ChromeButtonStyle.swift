import SwiftUI

/// A text control of the window's chrome (the Today button, status bar items, chips): its label
/// on a rounded fill that tints under the pointer and deepens while pressed, the pointing hand,
/// and 40% when disabled. The padding is always there, so hovering never moves anything.
public struct ChromeButtonStyle: ButtonStyle {
  let cornerRadius: CGFloat
  let padding: EdgeInsets
  let isSelected: Bool
  let showsBorder: Bool
  let brightensLabel: Bool

  /// - Parameters:
  ///   - isSelected: the chosen chip or tab (the pressed fill, at rest).
  ///   - showsBorder: a hairline outline (a small bordered button like Today).
  ///   - brightensLabel: the label goes from the muted to the primary text color on hover (for
  ///     labels without a color of their own).
  public init(
    cornerRadius: CGFloat = 6, horizontalPadding: CGFloat = 6, verticalPadding: CGFloat = 2,
    isSelected: Bool = false, showsBorder: Bool = false, brightensLabel: Bool = false
  ) {
    self.cornerRadius = cornerRadius
    self.padding = EdgeInsets(
      top: verticalPadding, leading: horizontalPadding, bottom: verticalPadding,
      trailing: horizontalPadding)
    self.isSelected = isSelected
    self.showsBorder = showsBorder
    self.brightensLabel = brightensLabel
  }

  public func makeBody(configuration: Configuration) -> some View {
    ChromeButtonBody(configuration: configuration, style: self)
  }

  fileprivate func fill(_ state: ControlState) -> Color {
    guard state.isEnabled else { return isSelected ? Theme.pressed : .clear }
    if state.isPressed || isSelected { return Theme.pressed }
    return state.isHovered ? Theme.hover : .clear
  }
}

private struct ChromeButtonBody: View {
  let configuration: ButtonStyleConfiguration
  let style: ChromeButtonStyle
  @State private var hovering = false
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    let state = ControlState(
      isHovered: hovering, isPressed: configuration.isPressed, isEnabled: isEnabled)
    configuration.label
      .foregroundStyle(
        style.brightensLabel && hovering && isEnabled ? Theme.text : Theme.mutedText
      )
      .padding(style.padding)
      .background(RoundedRectangle(cornerRadius: style.cornerRadius).fill(style.fill(state)))
      .overlay {
        if style.showsBorder {
          RoundedRectangle(cornerRadius: style.cornerRadius).strokeBorder(Theme.separator)
        }
      }
      .contentShape(RoundedRectangle(cornerRadius: style.cornerRadius))
      .opacity(isEnabled ? 1 : ControlState.disabledOpacity)
      .onHover { hovering = $0 }
      .pointingHandCursor()
      .animation(.easeOut(duration: ControlState.hoverDuration), value: hovering)
      .animation(.easeOut(duration: ControlState.pressDuration), value: configuration.isPressed)
  }
}

extension View {
  /// Hover (and press) feedback for a custom clickable view that isn't a `Button` (a tab, a
  /// row): the rounded fill tints under the pointer, eased like every other control.
  public func hoverHighlight(
    _ isHovered: Bool, isPressed: Bool = false, isSelected: Bool = false,
    cornerRadius: CGFloat = 6
  ) -> some View {
    background(
      RoundedRectangle(cornerRadius: cornerRadius)
        .fill(
          isSelected || isPressed ? Theme.pressed : isHovered ? Theme.hover : .clear)
    )
    .animation(.easeOut(duration: ControlState.hoverDuration), value: isHovered)
  }
}
