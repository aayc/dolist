import DailyDoListDomain
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Where a thread's task lives, for "Show in Note".
public struct TaskLocation: Hashable, Sendable {
  public var threadId: String
  public var taskId: String?
  public var notePath: String
  /// The latest record (current line and text) when the task is tracked.
  public var record: TaskAgentRecord?

  public init(threadId: String, taskId: String?, notePath: String, record: TaskAgentRecord?) {
    self.threadId = threadId
    self.taskId = taskId
    self.notePath = notePath
    self.record = record
  }
}

/// Tabs of a thread; Browser and Computer only exist while the thread exposes those surfaces.
enum ThreadTab: String, CaseIterable, Hashable, Identifiable {
  case chat, artifacts, browser, computer

  var id: String { rawValue }

  static func available(for surfaces: [SurfaceKind]) -> [ThreadTab] {
    var tabs: [ThreadTab] = [.chat, .artifacts]
    if surfaces.contains(.browser) { tabs.append(.browser) }
    if surfaces.contains(.computer) { tabs.append(.computer) }
    return tabs
  }

  func title(artifactCount: Int) -> String {
    switch self {
    case .chat: "Chat"
    case .artifacts: artifactCount > 0 ? "Artifacts \(artifactCount)" : "Artifacts"
    case .browser: "Browser"
    case .computer: "Computer"
    }
  }
}

/// One task's thread: header with Stop / Retry / Repeat This / Show in Note / Close, and Chat,
/// Artifacts, Browser and Computer tabs. Loads the thread and marks it read while on screen. In
/// the Chat tab, Stop sits beside Send in the chat bar instead of the header. A routine's run has
/// no Show in Note or Repeat This (it already repeats).
public struct ThreadView: View {
  let store: AgentStore
  let threadId: String
  let onShowInNote: ((TaskLocation) -> Void)?
  let onClose: (() -> Void)?
  let stop: AgentPanelShortcuts.Command
  let onRepeat: ((RoutineDraft) -> Void)?
  @State private var tab: ThreadTab
  @State private var openArtifact: ArtifactSelection?
  /// Inactive while the app is in the background: messages aren't "read" then.
  @Environment(\.controlActiveState) private var activeState

  struct ArtifactSelection: Identifiable, Hashable {
    var threadId: String
    var artifactId: String
    var id: String { "\(threadId)/\(artifactId)" }
  }

  /// - Parameters:
  ///   - stop: the host's Stop command (its shortcut shows in the Stop buttons' tooltips).
  ///   - onRepeat: opens the New Routine sheet with a finished task as the draft ("Repeat this").
  public init(
    store: AgentStore, threadId: String, onShowInNote: ((TaskLocation) -> Void)? = nil,
    onClose: (() -> Void)? = nil, stop: AgentPanelShortcuts.Command = .init(),
    onRepeat: ((RoutineDraft) -> Void)? = nil
  ) {
    self.init(
      store: store, threadId: threadId, tab: .chat, onShowInNote: onShowInNote, onClose: onClose,
      stop: stop, onRepeat: onRepeat)
  }

  init(
    store: AgentStore, threadId: String, tab: ThreadTab,
    onShowInNote: ((TaskLocation) -> Void)? = nil,
    onClose: (() -> Void)? = nil, stop: AgentPanelShortcuts.Command = .init(),
    onRepeat: ((RoutineDraft) -> Void)? = nil
  ) {
    self.store = store
    self.threadId = threadId
    self.onShowInNote = onShowInNote
    self.onClose = onClose
    self.stop = stop
    self.onRepeat = onRepeat
    self._tab = State(initialValue: tab)
  }

  public var body: some View {
    let thread = store.thread(threadId)
    let summary = store.threads[threadId]
    let surfaces = thread?.surfaces ?? summary?.surfaces ?? []
    let tabs = ThreadTab.available(for: surfaces)
    let selected = tabs.contains(tab) ? tab : .chat
    let artifactCount = thread?.artifacts.count ?? summary?.artifactCount ?? 0
    VStack(spacing: 0) {
      header(thread: thread, summary: summary, showsStop: thread == nil || selected != .chat)
      ThreadTabBar(tabs: tabs, selection: $tab, artifactCount: artifactCount)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
      Hairline()
      content(thread: thread, tab: selected)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .task(id: threadId) {
      await store.loadThread(threadId)
      if activeState != .inactive { store.markRead(threadId) }
    }
    .onChange(of: store.unreadCount(forThread: threadId)) { _, unread in
      // New agent messages while the thread is on screen count as read.
      if unread > 0, activeState != .inactive { store.markRead(threadId) }
    }
    .onChange(of: activeState) { _, state in
      if state != .inactive, store.unreadCount(forThread: threadId) > 0 { store.markRead(threadId) }
    }
    .sheet(item: $openArtifact) { selection in
      ArtifactViewer(store: store, threadId: selection.threadId, artifactId: selection.artifactId)
    }
  }

  private func header(thread: AgentThread?, summary: ThreadSummary?, showsStop: Bool) -> some View {
    let status = thread?.status ?? summary?.status ?? .idle
    let isRoutineRun = (thread?.routineId ?? summary?.routineId) != nil
    let notePath = thread?.notePath ?? summary?.notePath
    let taskId = thread?.taskId ?? summary?.taskId
    let title = thread?.title ?? summary?.title ?? "Task"
    return ThreadHeader(
      title: title,
      status: status,
      notePath: isRoutineRun ? nil : notePath,
      stop: stop,
      onStop: status.isActive && showsStop
        ? { Task { await store.cancelThread(threadId) } } : nil,
      onRetry: [.failed, .cancelled, .done].contains(status)
        ? { Task { await store.retryThread(threadId) } } : nil,
      onRepeat: status == .done && !isRoutineRun && taskId != nil
        ? onRepeat.map { open in { open(RoutineDraft(repeating: title, threadId: threadId)) } }
        : nil,
      onShowInNote: isRoutineRun
        ? nil
        : notePath.flatMap { path in
          onShowInNote.map { show in
            {
              show(
                TaskLocation(
                  threadId: threadId, taskId: taskId, notePath: path,
                  record: store.record(forThread: threadId)))
            }
          }
        },
      onClose: onClose, readOnlyReason: store.readOnly?.reason)
  }

  @ViewBuilder
  private func content(thread: AgentThread?, tab: ThreadTab) -> some View {
    if let thread {
      switch tab {
      case .chat:
        ChatView(store: store, thread: thread, stop: stop) { artifactId in
          openArtifact = ArtifactSelection(threadId: thread.id, artifactId: artifactId)
        }
      case .artifacts:
        ArtifactsList(artifacts: thread.artifacts) { artifactId in
          openArtifact = ArtifactSelection(threadId: thread.id, artifactId: artifactId)
        }
      case .browser:
        BrowserSurfaceView(store: store, threadId: thread.id)
      case .computer:
        ComputerSurfaceView(store: store, threadId: thread.id)
      }
    } else if store.failedThreadIds.contains(threadId) && !store.loadingThreadIds.contains(threadId)
    {
      ContentUnavailableView {
        Label("Couldn't load this thread", systemImage: "exclamationmark.triangle")
      } description: {
        Text("Check that Daily Do List's background service is running.")
      } actions: {
        Button("Try Again") { Task { await store.loadThread(threadId, force: true) } }
          .pointingHandCursor()
      }
    } else {
      ProgressView().controlSize(.small)
    }
  }
}

struct ThreadHeader: View {
  let title: String
  let status: TaskAgentStatus
  let notePath: String?
  var stop = AgentPanelShortcuts.Command()
  let onStop: (() -> Void)?
  let onRetry: (() -> Void)?
  var onRepeat: (() -> Void)?
  let onShowInNote: (() -> Void)?
  let onClose: (() -> Void)?
  /// Stop and Retry can't reach the agent (they stay, disabled, and say why).
  var readOnlyReason: String?

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      VStack(alignment: .leading, spacing: 5) {
        Text(verbatim: title)
          .font(.system(size: 15, weight: .semibold))
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
          .tooltip(
            ifTruncated: title, font: .systemFont(ofSize: 15, weight: .semibold), lineLimit: 2)
        HStack(spacing: 8) {
          StatusChip(status: status, pulses: status.isRunning)
          if let notePath {
            HStack(spacing: 4) {
              Image(systemName: "doc.text")
              Text(verbatim: VaultPath.stem(notePath))
                .lineLimit(1)
                .tooltip(
                  ifTruncated: VaultPath.stem(notePath),
                  font: .preferredFont(forTextStyle: .caption1), showing: .path(notePath))
            }
            .font(.caption)
            .foregroundStyle(Theme.mutedText)
          }
        }
      }
      Spacer(minLength: 8)
      HStack(spacing: 0) {
        if let onStop {
          IconButton(
            "stop.circle", label: "Stop", keys: stop.keys, command: stop.id,
            isEnabled: readOnlyReason == nil, disabledReason: readOnlyReason, action: onStop)
        }
        if let onRetry {
          IconButton(
            "arrow.clockwise", label: "Retry", isEnabled: readOnlyReason == nil,
            disabledReason: readOnlyReason, action: onRetry)
        }
        if let onRepeat {
          IconButton(
            "clock.arrow.circlepath", label: "Repeat this", detail: "Make it a routine",
            action: onRepeat)
        }
        if let onShowInNote {
          IconButton("arrow.up.forward.square", label: "Show task in note", action: onShowInNote)
        }
        if let onClose { IconButton("xmark", label: "Close", action: onClose) }
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 8)
  }
}

/// Chat / Artifacts / Browser / Computer as quiet chips, like the editor's tabs.
struct ThreadTabBar: View {
  let tabs: [ThreadTab]
  @Binding var selection: ThreadTab
  let artifactCount: Int

  var body: some View {
    HStack(spacing: 2) {
      ForEach(tabs) { tab in
        ThreadTabChip(title: tab.title(artifactCount: artifactCount), isSelected: tab == selection)
        {
          selection = tab
        }
      }
      Spacer(minLength: 0)
    }
  }
}

private struct ThreadTabChip: View {
  let title: String
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(verbatim: title)
        .font(.system(size: 12, weight: isSelected ? .medium : .regular))
        .foregroundStyle(isSelected ? Theme.text : Theme.mutedText)
        .frame(height: 22)
    }
    .buttonStyle(
      ChromeButtonStyle(horizontalPadding: 10, verticalPadding: 2, isSelected: isSelected)
    )
    .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
  }
}

/// The Artifacts tab.
struct ArtifactsList: View {
  let artifacts: [ArtifactMeta]
  let onOpen: (String) -> Void

  var body: some View {
    if artifacts.isEmpty {
      ContentUnavailableView(
        "No Artifacts Yet", systemImage: "doc.on.doc",
        description: Text("Drafts, comparisons and files the agent produces show up here."))
    } else {
      ScrollView {
        LazyVStack(spacing: 8) {
          ForEach(artifacts) { artifact in
            ArtifactRow(meta: artifact) { onOpen(artifact.id) }
          }
        }
        .padding(12)
      }
    }
  }
}
