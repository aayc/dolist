import DailyDoListModels
import SwiftUI

/// The thread's messages with the composer below. Follows new content (and streamed text) while
/// scrolled to the bottom; leaves the position alone while the user reads further up.
struct ChatView: View {
  let store: AgentStore
  let thread: AgentThread
  let onOpenArtifact: (String) -> Void
  @State private var isPinned = true
  @State private var viewportHeight: CGFloat = 0
  @Environment(\.agentReferenceDate) private var referenceDate

  private static let bottomId = "chat-bottom"
  private nonisolated static let space = "chat-scroll"
  /// Within this distance from the bottom the list stays pinned to new content.
  private static let pinThreshold: CGFloat = 48

  /// Changes whenever the bottom of the list grows.
  private struct FollowKey: Equatable {
    var count: Int
    var lastId: String?
    var lastLength: Int
  }

  private var followKey: FollowKey {
    var length = 0
    if case .text(let text) = thread.messages.last { length = text.text.utf16.count }
    return FollowKey(count: thread.messages.count, lastId: thread.messages.last?.id, lastLength: length)
  }

  var body: some View {
    // Rows only need the day (today's times show without a date); a changing instant would
    // defeat their equality check on every streamed token.
    let now = Calendar.current.startOfDay(for: referenceDate ?? Date())
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(spacing: 0) {
            LazyVStack(alignment: .leading, spacing: 12) {
              ForEach(thread.messages) { message in
                MessageRow(
                  message: message, context: context(for: message, now: now),
                  onDecide: { id, decision, scope, note in
                    Task { await store.decide(id, decision, scope: scope, note: note) }
                  },
                  onOpenArtifact: onOpenArtifact
                )
                .equatable()
                .id(message.id)
              }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            if thread.messages.isEmpty {
              Text("No messages yet. The agent posts updates here as it works.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(24)
            }
            Color.clear
              .frame(height: 1)
              .id(Self.bottomId)
              .onGeometryChange(for: CGFloat.self) { geometry in
                geometry.frame(in: .named(Self.space)).minY
              } action: { bottom in
                let pinned = bottom <= viewportHeight + Self.pinThreshold
                if pinned != isPinned { isPinned = pinned }
              }
          }
        }
        .coordinateSpace(name: Self.space)
        .modifier(StartAtBottom())
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
          if height != viewportHeight { viewportHeight = height }
        }
        .onAppear { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
        .onChange(of: followKey) {
          guard isPinned else { return }
          proxy.scrollTo(Self.bottomId, anchor: .bottom)
        }
      }
      AgentHairline()
      Composer(store: store, threadId: thread.id)
    }
  }

  /// Opens scrolled to the newest message (macOS 15+; `onAppear` covers macOS 14) without
  /// anchoring later size changes, which would move the text while the user reads older messages.
  private struct StartAtBottom: ViewModifier {
    func body(content: Content) -> some View {
      if #available(macOS 15, *) {
        content.defaultScrollAnchor(.bottom, for: .initialOffset)
      } else {
        content
      }
    }
  }

  private func context(for message: ThreadMessage, now: Date) -> MessageContext {
    var context = MessageContext(now: now)
    switch message {
    case .approval(let item):
      context.approval = store.approvals[item.approvalId]
      context.isDeciding = store.decidingApprovalIds.contains(item.approvalId)
    case .artifact(let item):
      context.artifact = thread.artifacts.first { $0.id == item.artifactId }
    case .text(let text) where text.role == .user:
      context.isSending = store.sendingMessageIds.contains(text.id)
    default:
      break
    }
    return context
  }
}
