import DailyDoListModels
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

/// One task's thread: header with Stop / Retry / Show in Note / Close, and Chat, Artifacts,
/// Browser and Computer tabs. Loads the thread and marks it read while on screen.
public struct ThreadView: View {
  let store: AgentStore
  let threadId: String
  let onShowInNote: ((TaskLocation) -> Void)?
  let onClose: (() -> Void)?
  @State private var tab: ThreadTab
  @State private var openArtifact: ArtifactSelection?
  /// Inactive while the app is in the background: messages aren't "read" then.
  @Environment(\.controlActiveState) private var activeState

  struct ArtifactSelection: Identifiable, Hashable {
    var threadId: String
    var artifactId: String
    var id: String { "\(threadId)/\(artifactId)" }
  }

  public init(
    store: AgentStore, threadId: String, onShowInNote: ((TaskLocation) -> Void)? = nil,
    onClose: (() -> Void)? = nil
  ) {
    self.init(store: store, threadId: threadId, tab: .chat, onShowInNote: onShowInNote, onClose: onClose)
  }

  init(
    store: AgentStore, threadId: String, tab: ThreadTab, onShowInNote: ((TaskLocation) -> Void)? = nil,
    onClose: (() -> Void)? = nil
  ) {
    self.store = store
    self.threadId = threadId
    self.onShowInNote = onShowInNote
    self.onClose = onClose
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
      header(thread: thread, summary: summary)
      Picker("View", selection: $tab) {
        ForEach(tabs) { tab in
          Text(tab.title(artifactCount: artifactCount)).tag(tab)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .padding(.horizontal, 12)
      .padding(.bottom, 8)
      Divider()
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

  private func header(thread: AgentThread?, summary: ThreadSummary?) -> some View {
    let status = thread?.status ?? summary?.status ?? .idle
    let notePath = thread?.notePath ?? summary?.notePath
    let taskId = thread?.taskId ?? summary?.taskId
    return ThreadHeader(
      title: thread?.title ?? summary?.title ?? "Task",
      status: status,
      notePath: notePath,
      onStop: status.isActive ? { Task { await store.cancelThread(threadId) } } : nil,
      onRetry: [.failed, .cancelled, .done].contains(status)
        ? { Task { await store.retryThread(threadId) } } : nil,
      onShowInNote: notePath.flatMap { path in
        onShowInNote.map { show in
          {
            show(
              TaskLocation(
                threadId: threadId, taskId: taskId, notePath: path,
                record: store.record(forThread: threadId)))
          }
        }
      },
      onClose: onClose)
  }

  @ViewBuilder
  private func content(thread: AgentThread?, tab: ThreadTab) -> some View {
    if let thread {
      switch tab {
      case .chat:
        ChatView(store: store, thread: thread) { artifactId in
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
    } else if store.failedThreadIds.contains(threadId) && !store.loadingThreadIds.contains(threadId) {
      ContentUnavailableView {
        Label("Couldn't load this thread", systemImage: "exclamationmark.triangle")
      } description: {
        Text("Check that Daily Do List's background service is running.")
      } actions: {
        Button("Try Again") { Task { await store.loadThread(threadId, force: true) } }
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
  let onStop: (() -> Void)?
  let onRetry: (() -> Void)?
  let onShowInNote: (() -> Void)?
  let onClose: (() -> Void)?

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      VStack(alignment: .leading, spacing: 5) {
        Text(verbatim: title)
          .font(.system(size: 15, weight: .semibold))
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
          .help(title)
        HStack(spacing: 8) {
          StatusChip(status: status)
          if let notePath {
            Label(AgentFormat.noteName(notePath), systemImage: "doc.text")
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      }
      Spacer(minLength: 8)
      HStack(spacing: 0) {
        if let onStop { IconButton(systemImage: "stop.circle", help: "Stop", action: onStop) }
        if let onRetry { IconButton(systemImage: "arrow.clockwise", help: "Retry", action: onRetry) }
        if let onShowInNote {
          IconButton(systemImage: "arrow.up.forward.square", help: "Show in Note", action: onShowInNote)
        }
        if let onClose { IconButton(systemImage: "xmark", help: "Close", action: onClose) }
      }
      .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 12)
    .padding(.top, 10)
    .padding(.bottom, 8)
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
