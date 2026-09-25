import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// The orchestrator's own chat: every turn (what woke it, what it said, each decision as a tool
/// call linked to its task's thread, how long it thought) and a composer to write to it. Shown in
/// the agent panel and in a window of its own.
public struct OrchestratorChatView: View {
  let store: AgentStore
  let onOpenTask: (String) -> Void
  let onOpenWindow: (() -> Void)?
  let onClose: (() -> Void)?
  let noteLinks: AgentNoteLinks?
  let showsErrors: Bool

  /// - Parameters:
  ///   - onOpenTask: opens a task's thread (by thread id) from a decision's link.
  ///   - onOpenWindow: adds a button that opens this chat in a window of its own.
  ///   - onClose: adds a Close button.
  ///   - noteLinks: how `[[wikilinks]]` open and preview notes (nil: from the environment, as
  ///     inside ``AgentPanel``).
  ///   - showsErrors: shows failed actions as a banner (the agent panel shows its own).
  public init(
    store: AgentStore, onOpenTask: @escaping (String) -> Void, onOpenWindow: (() -> Void)? = nil,
    onClose: (() -> Void)? = nil, noteLinks: AgentNoteLinks? = nil, showsErrors: Bool = false
  ) {
    self.store = store
    self.onOpenTask = onOpenTask
    self.onOpenWindow = onOpenWindow
    self.onClose = onClose
    self.noteLinks = noteLinks
    self.showsErrors = showsErrors
  }

  public var body: some View {
    let id = OrchestratorThread.id
    let status = store.threadStatus(id) ?? .idle
    VStack(spacing: 0) {
      OrchestratorHeader(
        status: status,
        onStop: status == .working ? { Task { await store.cancelThread(id) } } : nil,
        onOpenWindow: onOpenWindow, onClose: onClose)
      AgentHairline()
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .task { await store.loadThread(id) }
    .overlay(alignment: .bottom) {
      if showsErrors, let alert = store.lastError {
        AgentErrorBanner(alert: alert) { store.dismissError(alert.id) }
          .padding(10)
          .transition(.move(edge: .bottom).combined(with: .opacity))
          .task(id: alert.id) {
            try? await Task.sleep(for: .seconds(8))
            store.dismissError(alert.id)
          }
      }
    }
    .foregroundStyle(AgentTheme.text)
    .tint(AgentTheme.accent)
    .modifier(NoteLinksEnvironment(noteLinks: noteLinks))
  }

  @ViewBuilder private var content: some View {
    let id = OrchestratorThread.id
    if let thread = store.orchestratorThread {
      OrchestratorMessages(store: store, thread: thread, onOpenTask: onOpenTask)
    } else if store.failedThreadIds.contains(id) && !store.loadingThreadIds.contains(id) {
      ContentUnavailableView {
        Label("Couldn't load the orchestrator's chat", systemImage: "exclamationmark.triangle")
      } description: {
        Text("Check that Daily Do List's background service is running.")
      } actions: {
        Button("Try Again") { Task { await store.loadThread(id, force: true) } }
          .pointingHandCursor()
      }
    } else {
      ProgressView().controlSize(.small)
    }
  }
}

private struct NoteLinksEnvironment: ViewModifier {
  let noteLinks: AgentNoteLinks?

  func body(content: Content) -> some View {
    if let noteLinks {
      content
        .environment(\.agentNoteLinks, noteLinks)
        .environment(\.openURL, LinkPolicy.openURLAction(noteLinks: noteLinks))
    } else {
      content
    }
  }
}

struct OrchestratorHeader: View {
  let status: TaskAgentStatus
  let onStop: (() -> Void)?
  let onOpenWindow: (() -> Void)?
  let onClose: (() -> Void)?

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      VStack(alignment: .leading, spacing: 5) {
        Text(verbatim: OrchestratorThread.title)
          .font(.system(size: 15, weight: .semibold))
        HStack(spacing: 8) {
          StatusChip(status: status)
          Text("Every task, every decision")
            .font(.caption)
            .foregroundStyle(AgentTheme.mutedText)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      HStack(spacing: 0) {
        if let onStop { IconButton("stop.circle", label: "Stop this run", action: onStop) }
        if let onOpenWindow {
          IconButton("macwindow", label: "Open in a separate window", action: onOpenWindow)
        }
        if let onClose { IconButton("xmark", label: "Close", action: onClose) }
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 8)
  }
}

/// The chat's messages with the composer below. Follows new content while scrolled to the bottom
/// and leaves the position alone while the user reads further up (like ``ChatView``).
struct OrchestratorMessages: View {
  let store: AgentStore
  let thread: AgentThread
  let onOpenTask: (String) -> Void
  @State private var isPinned = true
  @State private var viewportHeight: CGFloat = 0
  @Environment(\.agentReferenceDate) private var referenceDate

  private static let bottomId = "orchestrator-bottom"
  private nonisolated static let space = "orchestrator-scroll"
  private static let pinThreshold: CGFloat = 48

  private struct FollowKey: Equatable {
    var count: Int
    var lastId: String?
    var lastLength: Int
  }

  private var followKey: FollowKey {
    var length = 0
    if case .text(let text) = thread.messages.last { length = text.text.utf16.count }
    return FollowKey(
      count: thread.messages.count, lastId: thread.messages.last?.id, lastLength: length)
  }

  var body: some View {
    let now = Calendar.current.startOfDay(for: referenceDate ?? Date())
    let links = store.taskLinks(for: thread.messages)
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(spacing: 0) {
            if thread.messages.isEmpty {
              Text(
                "Each time the orchestrator wakes up — a task changed, you replied, a subagent finished — what it decided shows up here. Write to it below: ask what it's doing, or tell it what to change."
              )
              .font(.callout)
              .foregroundStyle(AgentTheme.mutedText)
              .fixedSize(horizontal: false, vertical: true)
              .padding(20)
            }
            LazyVStack(alignment: .leading, spacing: 12) {
              ForEach(thread.messages) { message in
                row(for: message, link: message.orchestratorTaskId.flatMap { links[$0] }, now: now)
                  .id(message.id)
              }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .environment(\.citationSources, thread.sources ?? [])
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
        .onGeometryChange(for: CGFloat.self) {
          $0.size.height
        } action: { height in
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

  @ViewBuilder
  private func row(for message: ThreadMessage, link: OrchestratorTaskLink?, now: Date) -> some View
  {
    if case .status(let status) = message, status.author == "orchestrator" {
      ThoughtRow(message: status, now: now)
    } else if let link {
      VStack(alignment: .leading, spacing: 4) {
        messageRow(message, now: now)
        OrchestratorTaskButton(link: link) { threadId in onOpenTask(threadId) }
      }
    } else {
      messageRow(message, now: now)
    }
  }

  private func messageRow(_ message: ThreadMessage, now: Date) -> some View {
    MessageRow(
      message: message, context: context(for: message, now: now),
      onDecide: { id, decision, scope, note in
        Task { await store.decide(id, decision, scope: scope, note: note) }
      },
      onOpenArtifact: { _ in }
    )
    .equatable()
  }

  private func context(for message: ThreadMessage, now: Date) -> MessageContext {
    var context = MessageContext(now: now)
    switch message {
    case .approval(let item):
      context.approval = store.approvals[item.approvalId]
      context.isDeciding = store.decidingApprovalIds.contains(item.approvalId)
    case .text(let text) where text.role == .user:
      context.isSending = store.sendingMessageIds.contains(text.id)
    default:
      break
    }
    return context
  }
}

/// "Thought for 3 s": that the orchestrator reasoned and for how long, never what it thought.
struct ThoughtRow: View {
  let message: StatusMessage
  let now: Date

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: "brain").imageScale(.small)
      Text(verbatim: message.text ?? "Thinking…")
      Spacer(minLength: 4)
      Text(verbatim: AgentFormat.timestamp(message.createdAt, now: now))
    }
    .font(.caption)
    .foregroundStyle(AgentTheme.faint)
    .accessibilityElement(children: .combine)
  }
}

/// The task a decision was about, under its tool call; opens the task's thread when it has one.
struct OrchestratorTaskButton: View {
  let link: OrchestratorTaskLink
  let action: (String) -> Void
  @State private var hovering = false

  var body: some View {
    if let threadId = link.threadId {
      Button {
        action(threadId)
      } label: {
        label.foregroundStyle(hovering ? AgentTheme.accentStrong : AgentTheme.accent)
      }
      .buttonStyle(.plain)
      .onHover { hovering = $0 }
      .pointingHandCursor()
      .tooltip("Open this task's thread")
      .accessibilityLabel("Open the thread of \(link.title)")
    } else {
      label.foregroundStyle(AgentTheme.faint)
    }
  }

  private var label: some View {
    HStack(spacing: 4) {
      Image(systemName: "arrow.turn.down.right").imageScale(.small)
      Text(verbatim: link.title).lineLimit(1).truncationMode(.tail)
    }
    .font(.caption)
    .padding(.leading, 10)
  }
}
