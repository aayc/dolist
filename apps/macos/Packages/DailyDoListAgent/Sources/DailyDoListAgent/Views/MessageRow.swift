import DailyDoListModels
import SwiftUI

/// What a message row needs besides the message (resolved by the chat, compared for updates).
struct MessageContext: Equatable, Sendable {
  var approval: ApprovalRequest?
  var isDeciding = false
  var artifact: ArtifactMeta?
  var isSending = false
  var now: Date
}

/// One entry of a thread. Equatable so streaming into one message doesn't re-render the others.
struct MessageRow: View, Equatable {
  let message: ThreadMessage
  let context: MessageContext
  let onDecide: (String, ApprovalDecision, ApprovalScope?, String?) -> Void
  let onOpenArtifact: (String) -> Void

  nonisolated static func == (a: MessageRow, b: MessageRow) -> Bool {
    a.message == b.message && a.context == b.context
  }

  var body: some View {
    switch message {
    case .text(let text):
      TextMessageView(message: text, isSending: context.isSending, now: context.now)
    case .toolCall(let call):
      ToolCallRow(call: call)
    case .approval(let item):
      if let approval = context.approval {
        ApprovalCard(approval: approval, isDeciding: context.isDeciding) { decision, scope, note in
          onDecide(item.approvalId, decision, scope, note)
        }
      } else {
        ApprovalPlaceholder()
      }
    case .artifact(let item):
      ArtifactRow(meta: context.artifact) { onOpenArtifact(item.artifactId) }
    case .status(let status):
      StatusDivider(message: status, now: context.now)
    case .unknown(let kind, _, _):
      Label("Unsupported message (\(kind))", systemImage: "questionmark.square.dashed")
        .font(.caption)
        .foregroundStyle(.tertiary)
    }
  }
}

/// Agent text (markdown, author and time), the user's own replies (bubbles), system notes.
struct TextMessageView: View {
  let message: TextMessage
  var isSending = false
  let now: Date

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
          .foregroundStyle(.secondary)
        Text(verbatim: time).font(.caption).foregroundStyle(.tertiary)
      }
      if message.streaming == true {
        StreamingText(text: message.text)
      } else {
        MarkdownView(source: message.text)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  private var userBubble: some View {
    VStack(alignment: .trailing, spacing: 4) {
      HStack(spacing: 6) {
        if isSending {
          ProgressView().controlSize(.mini)
          Text("Sending…")
        } else {
          Text(verbatim: time).foregroundStyle(.tertiary)
        }
        Text("You").fontWeight(.semibold)
      }
      .font(.caption)
      .foregroundStyle(.secondary)
      Text(verbatim: message.text)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 11)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 12).fill(AgentTheme.accent.opacity(0.15)))
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 36)
    .opacity(isSending ? 0.7 : 1)
    .accessibilityElement(children: .combine)
  }

  private var systemNote: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(systemName: "info.circle")
      Text(MarkdownRenderer.inline(message.text)).fixedSize(horizontal: false, vertical: true)
    }
    .font(.callout)
    .foregroundStyle(.secondary)
    .frame(maxWidth: .infinity, alignment: .leading)
    .environment(\.openURL, LinkPolicy.openURLAction)
  }
}

/// Text still streaming in: inline markdown only (partial blocks render badly) and a caret.
private struct StreamingText: View {
  let text: String

  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.55)) { context in
      let caretOn = Int(context.date.timeIntervalSinceReferenceDate / 0.55) % 2 == 0
      (Text(MarkdownRenderer.inline(text))
        + Text(verbatim: " ▍").foregroundStyle(AgentTheme.accent.opacity(caretOn ? 1 : 0.25)))
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
    }
    .environment(\.openURL, LinkPolicy.openURLAction)
    .accessibilityLabel(text)
    .accessibilityValue("Still writing")
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
          .foregroundStyle(.tertiary)
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
    Rectangle().fill(AgentTheme.border).frame(height: 1).frame(maxWidth: .infinity)
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
          .foregroundStyle(AgentTheme.accent)
          .frame(width: 30, height: 30)
          .background(RoundedRectangle(cornerRadius: 7).fill(AgentTheme.accent.opacity(0.12)))
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: meta?.title ?? "Artifact")
            .font(.system(size: 13, weight: .medium))
            .lineLimit(1)
          Text(verbatim: meta.map { "\($0.kindLabel) · \(AgentFormat.bytes($0.size))" } ?? "Loading…")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer(minLength: 4)
        Image(systemName: "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.tertiary)
      }
      .padding(8)
      .contentShape(Rectangle())
    }
    .buttonStyle(RowButtonStyle())
    .background(RoundedRectangle(cornerRadius: 8).strokeBorder(AgentTheme.border))
    .accessibilityLabel("Open \(meta?.title ?? "artifact")")
  }
}
