import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// The chat bar: an input that grows from one line to eight (then scrolls), Send, and Stop while
/// the agent works. A sent message shows in the thread at once and the input clears, keeping the
/// focus. The placeholder says what a reply does now. Disabled, with the reason, while the agent
/// can't act.
struct Composer: View {
  @State private var model: ComposerModel
  let stop: AgentPanelShortcuts.Command
  @State private var height = ComposerMetrics.minHeight
  @State private var isFocused = false
  @State private var focusRequest = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(store: AgentStore, threadId: String, stop: AgentPanelShortcuts.Command = .init()) {
    self.init(model: ComposerModel(store: store, threadId: threadId), stop: stop)
  }

  init(model: ComposerModel, stop: AgentPanelShortcuts.Command = .init()) {
    self._model = State(initialValue: model)
    self.stop = stop
  }

  var body: some View {
    let unavailable = model.unavailableReason
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .bottom, spacing: 6) {
        ZStack(alignment: .topLeading) {
          if model.text.isEmpty {
            Text(verbatim: model.placeholder)
              .font(Font(ComposerMetrics.font))
              .foregroundStyle(Theme.faintText)
              .lineLimit(1)
              .padding(.leading, 7)
              .padding(.top, ComposerMetrics.inset.height)
              .allowsHitTesting(false)
              .transition(.opacity)
              .id(model.placeholder)
          }
          ComposerTextView(
            text: $model.text, height: $height, isFocused: $isFocused,
            isEditable: unavailable == nil, focusRequest: focusRequest, onSubmit: { model.send() }
          )
          .frame(height: height)
        }
        .padding(.vertical, 3)
        HStack(spacing: 6) {
          if model.canStop {
            StopButton(
              isStopping: model.isStopping, unavailableReason: model.stopUnavailableReason,
              command: stop
            ) { model.stop() }
            .transition(
              reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
          }
          SendButton(isEnabled: model.canSend) { model.send() }
        }
        .padding(.bottom, 1)
      }
      .padding(.leading, 6)
      .padding(.trailing, 5)
      .padding(.vertical, 4)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.elevated)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(isFocused ? Theme.accent.opacity(0.7) : Theme.separator)
      )
      .shadow(
        color: isFocused ? Theme.accent.opacity(0.28) : .black.opacity(0.12),
        radius: isFocused ? 7 : 3, y: isFocused ? 0 : 1
      )
      .contentShape(Rectangle())
      .onTapGesture { focusRequest += 1 }
      .animation(.easeOut(duration: 0.14), value: isFocused)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: height)
      .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: model.canStop)
      .animation(.easeOut(duration: 0.15), value: model.placeholder)
      if let unavailable {
        Label(unavailable, systemImage: "pause.circle")
          .font(.caption)
          .foregroundStyle(Theme.mutedText)
          .lineLimit(2)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }

  /// Return sends; Shift-Return starts a new line.
  static let sendTooltip = TooltipContent(lines: [
    .init("Send", keys: .returnKey), .init("New line", keys: .shiftReturn),
  ])
}

/// The send arrow in an accent circle: a shade stronger under the pointer, a touch smaller while
/// pressed, a quiet gray while there's nothing to send.
private struct SendButton: View {
  let isEnabled: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: "arrow.up")
        .font(.system(size: 13, weight: .bold))
    }
    .buttonStyle(ComposerButtonStyle(kind: .send))
    .tooltip(Composer.sendTooltip, accessibility: .keysOnly)
    .accessibilityLabel("Send")
    .disabled(!isEnabled)
  }
}

/// Stops the agent: a square in a quiet circle, with the host's Stop shortcut.
private struct StopButton: View {
  let isStopping: Bool
  var unavailableReason: String?
  let command: AgentPanelShortcuts.Command
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      if isStopping {
        ProgressView().controlSize(.mini)
      } else {
        RoundedRectangle(cornerRadius: 2.5, style: .continuous).frame(width: 9, height: 9)
      }
    }
    .buttonStyle(ComposerButtonStyle(kind: .stop))
    .tooltip(
      TooltipContent("Stop", keys: command.keys),
      whenDisabled: unavailableReason.map { TooltipContent("Stop", detail: $0) },
      command: command.id, accessibility: .keysOnly
    )
    .accessibilityLabel("Stop")
    .disabled(isStopping || unavailableReason != nil)
  }
}

/// The composer's round buttons.
private struct ComposerButtonStyle: ButtonStyle {
  enum Kind { case send, stop }
  let kind: Kind

  func makeBody(configuration: Configuration) -> some View {
    Face(configuration: configuration, kind: kind)
  }

  private struct Face: View {
    let configuration: Configuration
    let kind: Kind
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
      configuration.label
        .foregroundStyle(foreground)
        .frame(width: 26, height: 26)
        .background(Circle().fill(fill))
        .contentShape(Circle())
        .scaleEffect(configuration.isPressed && isEnabled ? 0.92 : 1)
        .onHover { hovering = $0 }
        .pointingHandCursor()
        .animation(.easeOut(duration: 0.11), value: hovering)
        .animation(.easeOut(duration: 0.06), value: configuration.isPressed)
        .animation(.easeOut(duration: 0.15), value: isEnabled)
    }

    private var fill: Color {
      switch kind {
      case .send:
        guard isEnabled else { return Theme.hover }
        return hovering || configuration.isPressed ? Theme.accentStrong : Theme.accent
      case .stop:
        return hovering || configuration.isPressed ? Theme.pressed : Theme.hover
      }
    }

    private var foreground: Color {
      switch kind {
      case .send: isEnabled ? .white : Theme.faintText
      case .stop: Theme.text
      }
    }
  }
}
