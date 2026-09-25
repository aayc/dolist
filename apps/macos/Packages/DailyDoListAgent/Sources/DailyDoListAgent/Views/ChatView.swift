import DailyDoListModels
import SwiftUI

/// The thread's messages with the chat bar below. Agent text that arrives while the chat is open
/// types out (`ChatReveal`); a live row at the end says what the agent is doing; finished tool
/// calls collapse. The list follows new content while scrolled to the bottom and leaves the
/// position alone while the user reads further up, offering "Jump to latest" instead.
struct ChatView: View {
  let store: AgentStore
  let thread: AgentThread
  var stop = AgentPanelShortcuts.Command()
  let onOpenArtifact: (String) -> Void
  @State private var reveal = ChatReveal()
  @State private var tracker = ScrollTracker()
  @State private var isPinned = true
  @State private var unseen = 0
  @Environment(\.agentReferenceDate) private var referenceDate
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private static let bottomId = "chat-bottom"
  private static let activityId = "chat-activity"
  private nonisolated static let space = "chat-scroll"

  /// - Parameter reveal: types out agent text (tests pass one with a manual clock).
  init(
    store: AgentStore, thread: AgentThread, stop: AgentPanelShortcuts.Command = .init(),
    reveal: ChatReveal? = nil, onOpenArtifact: @escaping (String) -> Void
  ) {
    self.store = store
    self.thread = thread
    self.stop = stop
    self.onOpenArtifact = onOpenArtifact
    if let reveal { self._reveal = State(initialValue: reveal) }
  }

  /// Where the content is in the scroll view (its top, relative to the viewport's) and how tall.
  struct ContentFrame: Equatable {
    var minY: CGFloat
    var height: CGFloat
  }

  /// The follow state and the last layout, outside SwiftUI state: they change on every scroll
  /// frame, and only a change of `isPinned` or `unseen` should redraw the chat.
  @MainActor
  final class ScrollTracker {
    var scroll = ChatScroll()
    var content = ContentFrame(minY: 0, height: 0)
    var viewportHeight: CGFloat = 0

    /// Returns whether to scroll to the bottom.
    func layoutChanged() -> Bool {
      scroll.layoutChanged(
        contentHeight: content.height, viewportHeight: viewportHeight,
        distanceFromBottom: content.minY + content.height - viewportHeight)
    }
  }

  var body: some View {
    // Rows only need the day (today's times show without a date); a changing instant would
    // defeat their equality check on every streamed token.
    let now = Calendar.current.startOfDay(for: referenceDate ?? Date())
    let items = ChatItem.make(thread.messages, aliases: store.messageAliases)
    let activity = ChatActivity.current(
      status: thread.status, messages: thread.messages,
      pendingApprovals: store.pendingApprovals(forThread: thread.id),
      isTextActive: reveal.isRevealing || hasStreamingText)
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(spacing: 0) {
            LazyVStack(alignment: .leading, spacing: 12) {
              ForEach(items) { item in
                row(item, now: now)
                  .id(item.id)
                  .transition(entrance)
              }
              if let activity {
                ActivityRow(activity: activity) { showApproval(of: activity, proxy: proxy) }
                  .id(Self.activityId)
                  .transition(.opacity)
              }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .environment(\.citationSources, thread.sources ?? [])
            .animation(
              reduceMotion ? .easeOut(duration: 0.12) : .easeOut(duration: 0.18),
              value: items.map(\.id)
            )
            .animation(.easeOut(duration: 0.18), value: activity?.kind)
            if thread.messages.isEmpty && activity == nil {
              Text("No messages yet. The agent posts updates here as it works.")
                .font(.callout)
                .foregroundStyle(AgentTheme.mutedText)
                .padding(24)
            }
            Color.clear
              .frame(height: 1)
              .id(Self.bottomId)
          }
          .onGeometryChange(for: ContentFrame.self) { geometry in
            let frame = geometry.frame(in: .named(Self.space))
            return ContentFrame(minY: frame.minY, height: frame.height)
          } action: { frame in
            tracker.content = frame
            follow(proxy)
          }
        }
        .coordinateSpace(name: Self.space)
        .modifier(StartAtBottom())
        .onGeometryChange(for: CGFloat.self) {
          $0.size.height
        } action: { height in
          tracker.viewportHeight = height
          follow(proxy)
        }
        .overlay(alignment: .bottom) {
          if !isPinned {
            JumpToLatestPill(unseen: unseen) { jumpToLatest(proxy) }
              .padding(.bottom, 10)
              .transition(
                reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
          }
        }
        .animation(.snappy(duration: 0.2), value: isPinned)
        .onAppear { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
      }
      AgentHairline()
      Composer(store: store, threadId: thread.id, stop: stop)
    }
    .background(RevealHost(reveal: reveal))
    .onAppear { reveal.open(with: thread.messages) }
    .onDisappear { reveal.close() }
    .onChange(of: thread.messages) { old, new in
      reveal.sync(new)
      tracker.scroll.arrived(Self.arrivals(from: old, to: new))
      publishScroll()
    }
  }

  private var hasStreamingText: Bool {
    thread.messages.contains {
      if case .text(let text) = $0 { text.role == .agent && text.streaming == true } else { false }
    }
  }

  /// New rows fade in and rise a little (only fade with Reduce Motion); history doesn't animate.
  private var entrance: AnyTransition {
    reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 8))
  }

  @ViewBuilder
  private func row(_ item: ChatItem, now: Date) -> some View {
    switch item.content {
    case .tools(let calls):
      ToolRunView(calls: calls).equatable()
    case .message(let message):
      MessageRow(message: message, context: context(for: message, now: now), actions: actions)
        .equatable()
    }
  }

  private var actions: MessageActions {
    let store = store
    let threadId = thread.id
    let reveal = reveal
    return MessageActions(
      decide: { id, decision, scope, note in
        Task { await store.decide(id, decision, scope: scope, note: note) }
      },
      openArtifact: onOpenArtifact,
      retry: { id in Task { await store.retryMessage(id, threadId: threadId) } },
      discard: { id in store.discardMessage(id, threadId: threadId) },
      announced: { id in reveal.markAnnounced(id) })
  }

  private func context(for message: ThreadMessage, now: Date) -> MessageContext {
    var context = MessageContext(now: now)
    switch message {
    case .approval(let item):
      context.approval = store.approvals[item.approvalId]
      context.isDeciding = store.decidingApprovalIds.contains(item.approvalId)
      context.readOnlyReason = store.readOnly?.reason
      context.announces =
        context.approval?.isPending == true && reveal.needsAnnouncement(item.id)
    case .artifact(let item):
      context.artifact = thread.artifacts.first { $0.id == item.artifactId }
    case .text(let text) where text.role == .user:
      context.isSending = store.sendingMessageIds.contains(text.id)
      context.unsent = store.unsentMessages[text.id]
    case .text(let text):
      context.reveal = reveal.presentation(of: text)
    default:
      break
    }
    return context
  }

  // MARK: Scrolling

  /// Keeps the bottom in view while pinned; the user scrolling decides whether it's pinned.
  private func follow(_ proxy: ScrollViewProxy) {
    if tracker.layoutChanged() { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
    publishScroll()
  }

  private func publishScroll() {
    if tracker.scroll.isPinned != isPinned { isPinned = tracker.scroll.isPinned }
    if tracker.scroll.unseen != unseen { unseen = tracker.scroll.unseen }
  }

  private func jumpToLatest(_ proxy: ScrollViewProxy) {
    tracker.scroll.jumpToLatest()
    publishScroll()
    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.35)) {
      proxy.scrollTo(Self.bottomId, anchor: .bottom)
    }
  }

  private func showApproval(of activity: ChatActivity, proxy: ScrollViewProxy) {
    guard case .approval(_, let messageId?) = activity.kind else { return }
    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.35)) {
      proxy.scrollTo(messageId, anchor: .center)
    }
  }

  /// Messages that arrived between two versions of the thread (tool calls don't count: they
  /// collapse into one row).
  nonisolated static func arrivals(from old: [ThreadMessage], to new: [ThreadMessage]) -> Int {
    guard new.count > old.count else { return 0 }
    let known = Set(old.map(\.id))
    return new.reduce(0) { count, message in
      if case .toolCall = message { return count }
      return known.contains(message.id) ? count : count + 1
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
}
