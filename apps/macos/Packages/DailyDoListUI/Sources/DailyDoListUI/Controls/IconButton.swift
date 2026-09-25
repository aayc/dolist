import SwiftUI

/// The icon button of every pane: an SF Symbol on a square that tints under the pointer, deepens
/// and shrinks a little while pressed, shows the pointing hand and a tooltip (its name and
/// shortcut), and fades to 40% when disabled (no hover, no hand, no tooltip). Its name is its
/// accessibility label; the shortcut is spoken as the hint.
public struct IconButton: View {
  public enum Size: Hashable, Sendable {
    /// 28 × 28, a 13 pt glyph: pane headers.
    case regular
    /// 24 × 24, a 10 pt semibold glyph: quiet rows (the daily note navigator).
    case compact

    var side: CGFloat { self == .regular ? 28 : 24 }
    var glyph: CGFloat { self == .regular ? 13 : 10 }
    var weight: Font.Weight { self == .regular ? .regular : .semibold }
  }

  let systemImage: String
  let tooltip: TooltipContent
  let command: String?
  let isActive: Bool
  let isEnabled: Bool
  let size: Size
  let role: ButtonRole?
  let action: () -> Void

  /// - Parameters:
  ///   - label: its name: the tooltip and the accessibility label ("New note").
  ///   - keys: the shortcut of the command it runs, from the app's command catalog.
  ///   - command: that command's id (tests match the keys against the catalog).
  ///   - detail: a second, muted line in the tooltip ("2 waiting for approval").
  ///   - isActive: draws the glyph in the accent color (a mode that's on).
  public init(
    _ systemImage: String, label: String, keys: KeyShortcut? = nil, command: String? = nil,
    detail: String? = nil, isActive: Bool = false, isEnabled: Bool = true,
    size: Size = .regular, role: ButtonRole? = nil, action: @escaping () -> Void
  ) {
    self.systemImage = systemImage
    self.tooltip = TooltipContent(label, keys: keys, detail: detail)
    self.command = command
    self.isActive = isActive
    self.isEnabled = isEnabled
    self.size = size
    self.role = role
    self.action = action
  }

  public var body: some View {
    Button(role: role, action: action) {
      Image(systemName: systemImage)
        .font(.system(size: size.glyph, weight: size.weight))
    }
    .buttonStyle(IconButtonStyle(size: size, isActive: isActive))
    .tooltip(tooltip, command: command, accessibility: .keysOnly)
    .accessibilityLabel(tooltip.lines.first?.text ?? "")
    .disabled(!isEnabled)
  }
}

/// ``IconButton``'s look and feel, for buttons that need their own label.
public struct IconButtonStyle: ButtonStyle {
  let size: IconButton.Size
  let isActive: Bool

  public init(size: IconButton.Size = .regular, isActive: Bool = false) {
    self.size = size
    self.isActive = isActive
  }

  public func makeBody(configuration: Configuration) -> some View {
    IconButtonBody(configuration: configuration, size: size, isActive: isActive)
  }
}

private struct IconButtonBody: View {
  let configuration: ButtonStyleConfiguration
  let size: IconButton.Size
  let isActive: Bool
  @State private var hovering = false
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    IconButtonFace(
      size: size,
      state: ControlState(
        isHovered: hovering, isPressed: configuration.isPressed, isActive: isActive,
        isEnabled: isEnabled)
    ) {
      configuration.label
    }
    .onHover { hovering = $0 }
    .pointingHandCursor()
    .animation(.easeOut(duration: ControlState.hoverDuration), value: hovering)
    .animation(.easeOut(duration: ControlState.pressDuration), value: configuration.isPressed)
  }
}

/// What a control looks like right now (also rendered directly by the snapshot tests).
struct ControlState: Hashable {
  var isHovered = false
  var isPressed = false
  var isActive = false
  var isEnabled = true

  /// Hover tints ease in and out this fast.
  static let hoverDuration: TimeInterval = 0.11
  /// Press feedback.
  static let pressDuration: TimeInterval = 0.06
  static let disabledOpacity: Double = 0.4

  var fill: Color {
    guard isEnabled else { return .clear }
    if isPressed { return UIPalette.pressed }
    return isHovered ? UIPalette.hover : .clear
  }
}

/// An icon button in a given state.
struct IconButtonFace<Label: View>: View {
  let size: IconButton.Size
  let state: ControlState
  @ViewBuilder let label: Label

  var body: some View {
    label
      .foregroundStyle(
        state.isActive
          ? UIPalette.accent
          : state.isHovered && state.isEnabled ? UIPalette.text : UIPalette.mutedText
      )
      .frame(width: size.side, height: size.side)
      .background(RoundedRectangle(cornerRadius: 6).fill(state.fill))
      .contentShape(Rectangle())
      .scaleEffect(state.isPressed && state.isEnabled ? 0.96 : 1)
      .opacity(state.isEnabled ? 1 : ControlState.disabledOpacity)
  }
}
