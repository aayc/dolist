import DailyDoListUI
import SwiftUI

/// The live row at the end of a chat while its agent is queued or running: what it's doing now
/// ("Opening Safari…", "Thinking…"), and for how long once a step takes 3 s. Waiting for an
/// approval pulses and scrolls to the card when clicked.
struct ActivityRow: View {
  let activity: ChatActivity
  let onShowApproval: () -> Void
  @Environment(\.agentReferenceDate) private var referenceDate
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Group {
      if case .approval = activity.kind {
        Button(action: onShowApproval) {
          content.contentShape(Rectangle())
        }
        .buttonStyle(RowButtonStyle(cornerRadius: 7))
        .tooltip("Show the approval", accessibility: .none)
        .accessibilityHint("Scrolls to the approval")
      } else {
        content
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.updatesFrequently)
  }

  private var content: some View {
    HStack(spacing: 8) {
      indicator.frame(width: 20, height: 14)
      HStack(spacing: 4) {
        Text(verbatim: activity.label)
          .foregroundStyle(tint)
          .lineLimit(1)
          .truncationMode(.tail)
          .contentTransition(.opacity)
        elapsed
      }
      .font(.callout)
      if case .approval = activity.kind {
        Image(systemName: "arrow.up")
          .font(.caption.weight(.semibold))
          .foregroundStyle(AgentTheme.warning.opacity(0.8))
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 6)
    .padding(.vertical, 5)
    .animation(.easeOut(duration: 0.18), value: activity.label)
  }

  private var tint: Color {
    if case .approval = activity.kind { return AgentTheme.warning }
    return AgentTheme.mutedText
  }

  @ViewBuilder
  private var indicator: some View {
    switch activity.kind {
    case .thinking:
      ThinkingDots(animates: !reduceMotion)
    case .tool(let name):
      ZStack {
        ProgressView().controlSize(.small).scaleEffect(0.6)
        Image(systemName: ToolIcon.systemName(for: name))
          .font(.system(size: 7, weight: .bold))
          .foregroundStyle(AgentTheme.accent)
      }
    case .approval:
      ZStack {
        PulseDot(color: AgentPalette.warning, diameter: 10, animates: !reduceMotion)
          .opacity(0.5)
        Image(systemName: "exclamationmark.shield.fill")
          .font(.system(size: 11))
          .foregroundStyle(AgentTheme.warning)
      }
    case .waitingToStart:
      Image(systemName: "clock")
        .font(.system(size: 11))
        .foregroundStyle(AgentTheme.faint)
    }
  }

  /// "· 12s", ticking once a second (a fixed reference date freezes it).
  @ViewBuilder
  private var elapsed: some View {
    if let referenceDate {
      ElapsedLabel(since: activity.since, now: referenceDate)
    } else if activity.since != nil {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        ElapsedLabel(since: activity.since, now: context.date)
      }
    }
  }
}

private struct ElapsedLabel: View {
  let since: Double?
  let now: Date

  var body: some View {
    if let text = ChatActivity.elapsed(since: since, now: now) {
      Text(verbatim: "· \(text)")
        .monospacedDigit()
        .foregroundStyle(AgentTheme.faint)
    }
  }
}

/// Floats over the bottom of the chat while the user reads further up: "Jump to latest", with how
/// many messages arrived since. Scrolls down smoothly.
struct JumpToLatestPill: View {
  let unseen: Int
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: "arrow.down").font(.system(size: 10, weight: .bold))
        Text("Jump to latest").font(.system(size: 12, weight: .medium))
        if unseen > 0 {
          CountBadge(count: unseen)
            .accessibilityLabel(unseen == 1 ? "1 new message" : "\(unseen) new messages")
        }
      }
      .foregroundStyle(AgentTheme.text)
      .padding(.leading, 10)
      .padding(.trailing, unseen > 0 ? 6 : 11)
      .padding(.vertical, 5)
      .background(Capsule().fill(AgentTheme.cardBackground))
      .overlay(Capsule().strokeBorder(AgentTheme.border))
      .shadow(color: .black.opacity(0.22), radius: 8, y: 2)
      .contentShape(Capsule())
    }
    .buttonStyle(PillButtonStyle())
    .accessibilityElement(children: .combine)
  }

  private struct PillButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
      Face(configuration: configuration)
    }

    private struct Face: View {
      let configuration: Configuration
      @State private var hovering = false

      var body: some View {
        configuration.label
          .brightness(hovering ? 0.04 : 0)
          .scaleEffect(configuration.isPressed ? 0.96 : 1)
          .onHover { hovering = $0 }
          .pointingHandCursor()
          .animation(.easeOut(duration: 0.11), value: hovering)
          .animation(.easeOut(duration: 0.06), value: configuration.isPressed)
      }
    }
  }
}
