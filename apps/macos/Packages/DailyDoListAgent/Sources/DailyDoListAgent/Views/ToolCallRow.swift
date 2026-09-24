import DailyDoListModels
import SwiftUI

/// One tool call: icon by family, label, duration, status; expands to the input JSON.
struct ToolCallRow: View {
  let call: ToolCallMessage
  @State private var expanded: Bool

  init(call: ToolCallMessage, expanded: Bool = false) {
    self.call = call
    self._expanded = State(initialValue: expanded)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.snappy(duration: 0.18)) { expanded.toggle() }
      } label: {
        HStack(spacing: 7) {
          Image(systemName: ToolIcon.systemName(for: call.toolName))
            .foregroundStyle(AgentTheme.mutedText)
            .frame(width: 16)
          Text(verbatim: call.label ?? call.toolName)
            .lineLimit(1)
            .truncationMode(.tail)
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
            .foregroundStyle(AgentTheme.faint)
            .rotationEffect(.degrees(expanded ? 90 : 0))
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
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
    .background(RoundedRectangle(cornerRadius: 8).fill(AgentTheme.subtleFill))
    .overlay(
      RoundedRectangle(cornerRadius: 8)
        .strokeBorder(call.status == .blocked ? AgentTheme.warning.opacity(0.55) : AgentTheme.border)
    )
  }
}

/// Spinner while running; check, cross or shield when finished.
struct ToolStatusIcon: View {
  let status: ToolCallStatus

  var body: some View {
    Group {
      if status == .running {
        ProgressView()
          .controlSize(.small)
          .scaleEffect(0.7)
          .frame(width: 14, height: 14)
      } else {
        Image(systemName: status.systemImage).foregroundStyle(status.tone.color)
      }
    }
    .help(status.displayLabel)
  }
}
