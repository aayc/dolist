import DailyDoListModels
import SwiftUI

/// Reply box at the bottom of the chat. Disabled, with the reason, while the agent can't act.
struct Composer: View {
  let store: AgentStore
  let threadId: String
  @State private var text = ""
  @State private var height: CGFloat = 22
  @State private var sending = false

  var body: some View {
    let unavailable = store.unavailableReason
    let canSend = unavailable == nil && !sending
      && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    VStack(alignment: .leading, spacing: 4) {
      HStack(alignment: .bottom, spacing: 8) {
        ZStack(alignment: .topLeading) {
          if text.isEmpty {
            Text(unavailable == nil ? "Reply to the agent…" : "Replies are off while the agent can't act")
              .foregroundStyle(AgentTheme.faint)
              .padding(.leading, 7)
              .padding(.top, 3)
              .allowsHitTesting(false)
          }
          ComposerTextView(
            text: $text, height: $height, isEditable: unavailable == nil, onSubmit: send)
            .frame(height: height)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 8).fill(AgentTheme.cardBackground))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(AgentTheme.border))
        Button(action: send) {
          Image(systemName: "arrow.up.circle.fill")
            .font(.system(size: 22))
            .foregroundStyle(canSend ? AgentTheme.accent : AgentTheme.faint)
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .help("Send (Return) · New line (Shift-Return)")
        .accessibilityLabel("Send")
        .padding(.bottom, 3)
      }
      if let unavailable {
        Label(unavailable, systemImage: "pause.circle")
          .font(.caption)
          .foregroundStyle(AgentTheme.mutedText)
          .lineLimit(2)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
  }

  private func send() {
    let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty, !sending, store.isAgentAvailable else { return }
    sending = true
    let draft = text
    text = ""
    Task {
      let ok = await store.postMessage(threadId: threadId, text: message)
      sending = false
      if !ok && text.isEmpty { text = draft }
    }
  }
}
