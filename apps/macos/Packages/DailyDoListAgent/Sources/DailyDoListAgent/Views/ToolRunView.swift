import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// A chat row of tool calls: one call as its own row, or finished calls collapsed into "Used 6
/// tools" that expands to their rows.
struct ToolRunView: View, Equatable {
  let calls: [ToolCallMessage]

  var body: some View {
    if calls.count == 1, let call = calls.first {
      ToolCallRow(call: call)
    } else {
      ToolGroupRow(calls: calls)
    }
  }
}

/// Several finished tool calls in one compact row: their icons, "Used 6 tools", what they were,
/// how long they took.
struct ToolGroupRow: View {
  let calls: [ToolCallMessage]
  @State private var expanded: Bool
  @State private var hovering = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(calls: [ToolCallMessage], expanded: Bool = false) {
    self.calls = calls
    self._expanded = State(initialValue: expanded)
  }

  /// "Used 6 tools".
  var title: String { "Used \(calls.count) tools" }

  /// The distinct things the calls did, in order ("Search the web, Fetch web page").
  var summary: String {
    var seen = Set<String>()
    var names: [String] = []
    for call in calls {
      let name = call.label ?? humanize(call.toolName)
      if seen.insert(name).inserted { names.append(name) }
    }
    return names.joined(separator: ", ")
  }

  private var icons: [String] {
    var seen = Set<String>()
    return calls.map { ToolIcon.systemName(for: $0.toolName) }.filter { seen.insert($0).inserted }
      .prefix(3).map { $0 }
  }

  private var span: String? {
    guard let first = calls.first, let end = calls.compactMap(\.endedAt).max() else { return nil }
    return AgentFormat.duration(milliseconds: end - first.createdAt)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { expanded.toggle() }
      } label: {
        HStack(spacing: 7) {
          HStack(spacing: -3) {
            ForEach(icons, id: \.self) { icon in
              Image(systemName: icon)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(AgentTheme.mutedText)
                .frame(width: 16, height: 16)
                .background(Circle().fill(AgentTheme.cardBackground))
                .overlay(Circle().strokeBorder(AgentTheme.border))
            }
          }
          Text(verbatim: title).foregroundStyle(AgentTheme.text)
          Text(verbatim: summary)
            .foregroundStyle(AgentTheme.faint)
            .lineLimit(1)
            .truncationMode(.tail)
            .layoutPriority(-1)
          Spacer(minLength: 6)
          if let span {
            Text(verbatim: span)
              .font(.caption)
              .monospacedDigit()
              .foregroundStyle(AgentTheme.mutedText)
          }
          Image(systemName: ToolCallStatus.ok.systemImage)
            .foregroundStyle(ToolCallStatus.ok.tone.color)
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
      .accessibilityLabel("\(title): \(summary)")
      .accessibilityHint(expanded ? "Hides the tool calls" : "Shows the tool calls")

      if expanded {
        VStack(alignment: .leading, spacing: 5) {
          ForEach(calls, id: \.id) { call in ToolCallRow(call: call) }
        }
        .transition(.opacity)
      }
    }
    .font(.system(size: 12.5))
    .padding(.horizontal, 10)
    .padding(.vertical, 7)
    .background(
      RoundedRectangle(cornerRadius: 8).fill(
        hovering && !expanded ? AgentTheme.hoverFill : AgentTheme.subtleFill)
    )
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AgentTheme.border))
    .animation(.easeOut(duration: 0.11), value: hovering)
  }
}
