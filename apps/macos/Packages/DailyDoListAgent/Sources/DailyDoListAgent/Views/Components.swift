import DailyDoListModels
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
    .foregroundStyle(tone?.color ?? Color.secondary)
    .padding(.horizontal, 7)
    .padding(.vertical, 2)
    .background(Capsule().fill((tone?.color ?? Color.primary).opacity(tone == nil ? 0.07 : 0.14)))
  }
}

/// Filled count capsule (unread, pending approvals).
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
  }
}

/// Borderless icon button with a tooltip (which doubles as its accessibility label).
struct IconButton: View {
  let systemImage: String
  let help: String
  var role: ButtonRole?
  let action: () -> Void

  var body: some View {
    Button(role: role, action: action) {
      Image(systemName: systemImage)
        .frame(width: 24, height: 22)
        .contentShape(Rectangle())
    }
    .buttonStyle(.borderless)
    .help(help)
    .accessibilityLabel(help)
  }
}

/// Row-like button: a subtle highlight on hover and press (inbox rows, menu items).
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
        .opacity(isEnabled ? 1 : 0.45)
        .background(
          RoundedRectangle(cornerRadius: cornerRadius)
            .fill(
              configuration.isPressed
                ? AgentTheme.hoverFill : hovering ? AgentTheme.subtleFill : Color.clear)
        )
        .onHover { hovering = $0 }
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
        Text(alert.message).font(.caption).foregroundStyle(.secondary).lineLimit(3)
      }
      Spacer(minLength: 4)
      IconButton(systemImage: "xmark", help: "Dismiss", action: onDismiss)
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
      Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
    }
    .help(store.unavailableReason ?? text)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Agent: \(text)")
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
