import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// What a message row needs besides the message (resolved by the chat, compared for updates).
struct MessageContext: Equatable {
  var approval: ApprovalRequest?
  var isDeciding = false
  var artifact: ArtifactMeta?
  var isSending = false
  /// Why the user's message didn't go out (it offers a retry).
  var unsent: String?
  /// How agent text shows: whole, or typing out.
  var reveal: ChatReveal.Presentation = .whole
  /// A pending approval that just arrived (it draws attention once).
  var announces = false
  /// Decisions can't reach the agent from this device.
  var readOnlyReason: String?
  var now: Date
}

/// What a message row can do.
struct MessageActions {
  var decide: (String, ApprovalDecision, ApprovalScope?, String?) -> Void = { _, _, _, _ in }
  var openArtifact: (String) -> Void = { _ in }
  var retry: (String) -> Void = { _ in }
  var discard: (String) -> Void = { _ in }
  var announced: (String) -> Void = { _ in }
}

/// One entry of a thread. Equatable so streaming into one message doesn't re-render the others.
struct MessageRow: View, Equatable {
  let message: ThreadMessage
  let context: MessageContext
  var actions = MessageActions()

  nonisolated static func == (a: MessageRow, b: MessageRow) -> Bool {
    a.message == b.message && a.context == b.context
  }

  var body: some View {
    switch message {
    case .text(let text):
      TextMessageView(
        message: text, isSending: context.isSending, unsent: context.unsent,
        reveal: context.reveal, now: context.now,
        onRetry: { actions.retry(text.id) }, onDiscard: { actions.discard(text.id) })
    case .toolCall(let call):
      ToolCallRow(call: call)
    case .approval(let item):
      if let approval = context.approval {
        ApprovalCard(
          approval: approval, isDeciding: context.isDeciding, announces: context.announces,
          readOnlyReason: context.readOnlyReason, onAnnounced: { actions.announced(item.id) },
          onDecide: { decision, scope, note in
            actions.decide(item.approvalId, decision, scope, note)
          })
      } else {
        ApprovalPlaceholder()
      }
    case .artifact(let item):
      ArtifactRow(meta: context.artifact) { actions.openArtifact(item.artifactId) }
    case .status(let status):
      StatusDivider(message: status, now: context.now)
    case .unknown(let kind, _, _):
      Label("Unsupported message (\(kind))", systemImage: "questionmark.square.dashed")
        .font(.caption)
        .foregroundStyle(Theme.faintText)
    }
  }
}

/// Agent text (markdown, typing out when it arrives live), the user's own replies (bubbles),
/// system notes. Under the pointer, a message shows its time and a copy button.
struct TextMessageView: View {
  let message: TextMessage
  var isSending = false
  var unsent: String?
  var reveal: ChatReveal.Presentation = .whole
  let now: Date
  var onRetry: () -> Void = {}
  var onDiscard: () -> Void = {}
  @State private var hovering = false

  var body: some View {
    switch message.role {
    case .user: userBubble
    case .system: systemNote
    case .agent: agentMessage
    }
  }

  private var time: String { AgentFormat.timestamp(message.createdAt, now: now) }

  private var agentMessage: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Text(verbatim: AgentFormat.authorLabel(message.author))
          .font(.caption.weight(.semibold))
          .foregroundStyle(Theme.mutedText)
        Text(verbatim: time).font(.caption).foregroundStyle(Theme.faintText)
          .opacity(hovering ? 1 : 0)
      }
      AgentText(message: message, reveal: reveal)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .topTrailing) {
      CopyButton(text: message.text, label: "Copy message")
        .offset(y: -5)
        .opacity(hovering ? 1 : 0)
    }
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .accessibilityElement(children: .combine)
  }

  private var userBubble: some View {
    VStack(alignment: .trailing, spacing: 4) {
      HStack(spacing: 6) {
        if isSending {
          ProgressView().controlSize(.mini)
          Text("Sending…")
        } else if unsent == nil {
          Text(verbatim: time).foregroundStyle(Theme.faintText).opacity(hovering ? 1 : 0)
        }
        Text("You").fontWeight(.semibold)
      }
      .font(.caption)
      .foregroundStyle(Theme.mutedText)
      Text(verbatim: message.text)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 12).fill(Theme.accent.opacity(0.15)))
        .overlay(
          RoundedRectangle(cornerRadius: 12)
            .strokeBorder(Theme.danger.opacity(unsent == nil ? 0 : 0.6))
        )
        .overlay(alignment: .leading) {
          CopyButton(text: message.text, label: "Copy message")
            .offset(x: -30)
            .opacity(hovering && !isSending ? 1 : 0)
        }
        .opacity(isSending ? 0.7 : 1)
      if let unsent {
        UnsentBar(reason: unsent, onRetry: onRetry, onDiscard: onDiscard)
          .transition(.opacity)
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 36)
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .animation(.easeOut(duration: 0.15), value: unsent)
    .accessibilityElement(children: .contain)
  }

  private var systemNote: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(systemName: "info.circle")
      Text(MarkdownRenderer.inline(message.text)).fixedSize(horizontal: false, vertical: true)
    }
    .font(.callout)
    .foregroundStyle(Theme.mutedText)
    .frame(maxWidth: .infinity, alignment: .leading)
    .environment(\.openURL, LinkPolicy.openURLAction)
  }
}

/// An agent message's body. Typing out, it re-renders on every frame of the reveal: only this
/// view reads the revealed prefix, so the message's header and the rest of the chat stay put.
private struct AgentText: View {
  let message: TextMessage
  let reveal: ChatReveal.Presentation
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let (source, typing): (String, Bool) =
      switch reveal {
      case .whole: (message.text, message.streaming == true)
      case .pending: ("", true)
      case .revealing(let entry): (entry.visible, entry.isActive)
      }
    MarkdownView(source: source, caret: typing ? CaretMode(reduceMotion: reduceMotion) : nil)
      .accessibilityValue(typing ? "Still writing" : "")
  }
}

/// Under a message that didn't go out: why (in the tooltip), Retry and Discard.
private struct UnsentBar: View {
  let reason: String
  let onRetry: () -> Void
  let onDiscard: () -> Void

  var body: some View {
    HStack(spacing: 4) {
      Label("Not sent", systemImage: "exclamationmark.circle.fill")
        .labelStyle(UnsentLabelStyle())
        .tooltip("Couldn't send your message", detail: TooltipContent.sentence(reason))
      Button("Retry", action: onRetry)
        .buttonStyle(ChromeButtonStyle(horizontalPadding: 6, verticalPadding: 2))
        .foregroundStyle(Theme.accent)
      Button("Discard", action: onDiscard)
        .buttonStyle(ChromeButtonStyle(horizontalPadding: 6, verticalPadding: 2))
        .foregroundStyle(Theme.mutedText)
    }
    .font(.caption.weight(.medium))
  }

  private struct UnsentLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
      HStack(spacing: 4) {
        configuration.icon.foregroundStyle(Theme.danger)
        configuration.title.foregroundStyle(Theme.danger)
      }
    }
  }
}

/// A status change as a subtle divider ("── Booking agent started · 9:02 PM ──").
struct StatusDivider: View {
  let message: StatusMessage
  let now: Date

  var body: some View {
    HStack(spacing: 8) {
      line
      HStack(spacing: 5) {
        Image(systemName: message.status.systemImage).imageScale(.small)
        Text(verbatim: message.text ?? message.status.displayLabel).lineLimit(2)
        Text(verbatim: "· \(AgentFormat.timestamp(message.createdAt, now: now))")
          .foregroundStyle(Theme.faintText)
      }
      .font(.caption)
      .foregroundStyle(message.status.tone.color)
      .layoutPriority(1)
      line
    }
    .padding(.vertical, 2)
    .accessibilityElement(children: .combine)
  }

  private var line: some View {
    Rectangle().fill(Theme.separator).frame(height: 1).frame(maxWidth: .infinity)
  }
}

/// An artifact the agent produced; opens the viewer.
struct ArtifactRow: View {
  let meta: ArtifactMeta?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: meta?.kind.systemImage ?? "doc")
          .font(.system(size: 15))
          .foregroundStyle(Theme.accent)
          .frame(width: 30, height: 30)
          .background(RoundedRectangle(cornerRadius: 7).fill(Theme.accent.opacity(0.12)))
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: meta?.title ?? "Artifact")
            .font(.system(size: 13, weight: .medium))
            .lineLimit(1)
            .tooltip(
              ifTruncated: meta?.title ?? "Artifact", font: .systemFont(ofSize: 13, weight: .medium)
            )
          Text(
            verbatim: meta.map { "\($0.kindLabel) · \(AgentFormat.bytes($0.size))" } ?? "Loading…"
          )
          .font(.caption)
          .foregroundStyle(Theme.mutedText)
        }
        Spacer(minLength: 4)
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(Theme.faintText)
      }
      .padding(8)
      .contentShape(Rectangle())
    }
    .buttonStyle(RowButtonStyle())
    .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.separator))
    .accessibilityLabel("Open \(meta?.title ?? "artifact")")
  }
}
