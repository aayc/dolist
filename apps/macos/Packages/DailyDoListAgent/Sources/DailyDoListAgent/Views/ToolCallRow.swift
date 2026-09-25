import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// One tool call: icon by family, label, duration, status; expands to the input JSON.
struct ToolCallRow: View {
  let call: ToolCallMessage
  @State private var expanded: Bool
  @State private var hovering = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(call: ToolCallMessage, expanded: Bool = false) {
    self.call = call
    self._expanded = State(initialValue: expanded)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.18)) { expanded.toggle() }
      } label: {
        HStack(spacing: 7) {
          Image(systemName: ToolIcon.systemName(for: call.toolName))
            .foregroundStyle(AgentTheme.mutedText)
            .frame(width: 16)
          Text(verbatim: call.label ?? call.toolName)
            .lineLimit(1)
            .truncationMode(.tail)
            .tooltip(ifTruncated: call.label ?? call.toolName, font: .systemFont(ofSize: 12.5))
          if call.label != nil {
            Text(verbatim: call.toolName)
              .font(.system(size: 11, design: .monospaced))
              .foregroundStyle(AgentTheme.faint)
              .lineLimit(1)
              .layoutPriority(-1)
          }
          Spacer(minLength: 6)
          if let duration = AgentFormat.duration(of: call) {
            Text(verbatim: duration)
              .font(.caption)
              .monospacedDigit()
              .foregroundStyle(AgentTheme.mutedText)
          }
          ToolStatusIcon(status: call.status)
          Image(systemName: "chevron.right")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(hovering ? AgentTheme.mutedText : AgentTheme.faint)
            .rotationEffect(.degrees(expanded ? 90 : 0))
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .onHover { hovering = $0 }
      .pointingHandCursor()
      .accessibilityLabel("\(call.label ?? call.toolName), \(call.status.displayLabel)")
      .accessibilityHint(expanded ? "Hides the details" : "Shows the details")

      if let preview = call.resultPreview, !preview.isEmpty {
        Text(verbatim: preview)
          .font(.caption)
          .foregroundStyle(call.status == .error ? AgentTheme.danger : AgentTheme.mutedText)
          .lineLimit(expanded ? nil : 2)
          .textSelection(.enabled)
          .padding(.leading, 23)
          .fixedSize(horizontal: false, vertical: true)
      }
      if expanded {
        JSONBlock(text: call.input.prettyJSONString)
      }
    }
    .font(.system(size: 12.5))
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(
      RoundedRectangle(cornerRadius: 8).fill(
        hovering ? AgentTheme.hoverFill : AgentTheme.subtleFill)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 8)
        .strokeBorder(
          call.status == .blocked ? AgentTheme.warning.opacity(0.55) : AgentTheme.border)
    )
    .animation(.easeOut(duration: 0.11), value: hovering)
  }
}

/// Spinner while running; when it finishes, a check, cross or shield pops in.
struct ToolStatusIcon: View {
  let status: ToolCallStatus
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      if status == .running {
        ProgressView()
          .controlSize(.small)
          .scaleEffect(0.7)
          .transition(.opacity)
      } else {
        Image(systemName: status.systemImage)
          .foregroundStyle(status.tone.color)
          .transition(reduceMotion ? .opacity : .scale(scale: 0.3).combined(with: .opacity))
      }
    }
    .frame(width: 14, height: 14)
    .animation(
      reduceMotion ? .easeOut(duration: 0.12) : .spring(duration: 0.35, bounce: 0.45),
      value: status
    )
    .tooltip(status.displayLabel)
  }
}
