import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Colored status pill ("● Working"), same tones as the editor badges.
public struct StatusChip: View {
  let status: TaskAgentStatus
  let label: String?

  public init(status: TaskAgentStatus, label: String? = nil) {
    self.status = status
    self.label = label
  }

  public var body: some View {
    let tone = status.tone.color
    HStack(spacing: 4) {
      Circle().fill(tone).frame(width: 6, height: 6)
      Text(label ?? status.displayLabel)
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(tone)
    .padding(.horizontal, 7)
    .padding(.vertical, 2)
    .background(Capsule().fill(tone.opacity(0.14)))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Status: \(label ?? status.displayLabel)")
  }
}

/// Small capsule label (risk, categories, kinds). Neutral without a tone.
struct Chip: View {
  let text: String
  var tone: Tone?
  var systemImage: String?

  var body: some View {
    HStack(spacing: 3) {
      if let systemImage { Image(systemName: systemImage).imageScale(.small) }
      Text(text)
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(tone?.color ?? AgentTheme.mutedText)
    .padding(.horizontal, 7)
    .padding(.vertical, 2)
    .background(Capsule().fill((tone?.color ?? AgentTheme.text).opacity(tone == nil ? 0.07 : 0.14)))
  }
}

/// Filled count capsule (unread, pending approvals). A new count pops.
struct CountBadge: View {
  let count: Int
  var tone: Tone = .accent
  var systemImage: String?

  var body: some View {
    HStack(spacing: 2) {
      if let systemImage { Image(systemName: systemImage).imageScale(.small) }
      Text(verbatim: "\(count)")
    }
    .font(.caption2.weight(.bold))
    .monospacedDigit()
    .foregroundStyle(tone.onFillColor)
    .padding(.horizontal, 5)
    .padding(.vertical, 1.5)
    .background(Capsule().fill(tone.color))
    .popOnChange(of: count)
  }
}

/// A one-pixel line in ``AgentTheme/border``.
struct AgentHairline: View {
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    Rectangle()
      .fill(AgentTheme.border)
      .frame(height: 1 / max(displayScale, 1))
      .accessibilityHidden(true)
  }
}

/// Row-like button: a subtle highlight under the pointer that deepens while pressed, the pointing
/// hand, and 40% when disabled (inbox rows, artifacts, menu items).
struct RowButtonStyle: ButtonStyle {
  var cornerRadius: CGFloat = 8

  func makeBody(configuration: Configuration) -> some View {
    Row(configuration: configuration, cornerRadius: cornerRadius)
  }

  private struct Row: View {
    let configuration: Configuration
    let cornerRadius: CGFloat
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
      configuration.label
        .opacity(isEnabled ? 1 : 0.4)
        .background(
          RoundedRectangle(cornerRadius: cornerRadius)
            .fill(
              !isEnabled
                ? Color.clear
                : configuration.isPressed
                  ? AgentTheme.hoverFill : hovering ? AgentTheme.subtleFill : Color.clear)
        )
        .onHover { hovering = $0 }
        .pointingHandCursor()
        .animation(.easeOut(duration: 0.11), value: hovering)
        .animation(.easeOut(duration: 0.06), value: configuration.isPressed)
    }
  }
}

/// A scroll view whose content starts at the top-left even when it's smaller than the viewport
/// (a plain two-axis `ScrollView` centers small content).
struct TopLeadingScrollView<Content: View>: View {
  var axes: Axis.Set = [.horizontal, .vertical]
  @ViewBuilder var content: Content

  var body: some View {
    GeometryReader { proxy in
      ScrollView(axes) {
        content.frame(
          minWidth: axes.contains(.horizontal) ? proxy.size.width : nil,
          minHeight: axes.contains(.vertical) ? proxy.size.height : nil, alignment: .topLeading)
      }
    }
  }
}

/// Monospaced, selectable JSON (tool inputs, approval details).
struct JSONBlock: View {
  let text: String
  static let maxCharacters = 20_000

  var body: some View {
    let shown = text.count > Self.maxCharacters ? "\(text.prefix(Self.maxCharacters))\n…" : text
    ScrollView(.horizontal, showsIndicators: false) {
      Text(verbatim: shown)
        .font(.system(size: 11, design: .monospaced))
        .textSelection(.enabled)
        .fixedSize()
        .padding(8)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 6).fill(AgentTheme.codeBackground))
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(AgentTheme.border))
  }
}

/// Toast for `AgentStore.lastError`.
struct AgentErrorBanner: View {
  let alert: AgentAlert
  let onDismiss: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(AgentTheme.danger)
      VStack(alignment: .leading, spacing: 2) {
        Text(alert.title).font(.callout.weight(.semibold))
        Text(alert.message).font(.caption).foregroundStyle(AgentTheme.mutedText).lineLimit(3)
      }
      Spacer(minLength: 4)
      IconButton("xmark", label: "Dismiss", size: .compact, action: onDismiss)
    }
    .padding(10)
    .background(RoundedRectangle(cornerRadius: 10).fill(AgentTheme.cardBackground))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(AgentTheme.border))
    .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
    .accessibilityElement(children: .combine)
  }
}

/// "● 2 running" / "Paused" / "Unavailable" for headers.
struct AgentStatusIndicator: View {
  let store: AgentStore

  var body: some View {
    let (text, tone) = summary
    HStack(spacing: 5) {
      Circle().fill(tone.color).frame(width: 7, height: 7)
      Text(text).font(.caption).foregroundStyle(AgentTheme.mutedText).lineLimit(1)
    }
    .tooltip(tooltip, accessibility: .none)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Agent: \(text)")
  }

  /// What the dot and the word mean.
  private var tooltip: TooltipContent {
    if let reason = store.unavailableReason {
      return TooltipContent("The agent can't act", detail: TooltipContent.sentence(reason))
    }
    guard let status = store.status else { return TooltipContent("Connecting to the agent") }
    if status.mode == .off { return TooltipContent("The agent is off") }
    if !status.enabled { return TooltipContent("The agent is paused") }
    let queued = status.queued > 0 ? ", \(status.queued) queued" : ""
    if status.running > 0 { return TooltipContent("\(status.running) running\(queued)") }
    return TooltipContent(
      status.mode == .mock ? "The mock agent is idle" : "The agent is idle\(queued)")
  }

  private var summary: (String, Tone) {
    guard let status = store.status else { return ("Connecting…", .faint) }
    if let problem = status.problem, !problem.isEmpty { return ("Unavailable", .danger) }
    if status.mode == .off { return ("Off", .faint) }
    if !status.enabled { return ("Paused", .warning) }
    if status.running > 0 { return ("\(status.running) running", .info) }
    return (status.mode == .mock ? "Mock · idle" : "Idle", .success)
  }
}
