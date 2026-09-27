#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  /// Task and orchestrator conversations share the same native message, approval and composer UI.
  public struct MobileThreadView: View {
    let store: AgentStore
    let threadId: String
    let actionsEnabled: Bool
    let hostName: String?
    let drafts: MobileAgentDrafts?
    let openNote: (String, Int?) -> Void
    @State private var tab = "chat"
    @State private var artifact: ArtifactMeta?
    @State private var repeatDraft: RoutineDraft?
    @State private var isVisible = false
    @Environment(\.scenePhase) private var scenePhase

    public init(
      store: AgentStore, threadId: String, actionsEnabled: Bool = false, hostName: String? = nil,
      drafts: MobileAgentDrafts? = nil, openNote: @escaping (String, Int?) -> Void = { _, _ in }
    ) {
      self.store = store
      self.threadId = threadId
      self.actionsEnabled = actionsEnabled
      self.hostName = hostName
      self.drafts = drafts
      self.openNote = openNote
    }

    private var canAct: Bool {
      actionsEnabled && !store.cachedContentReadOnly && !store.cachedThreadIDs.contains(threadId)
    }

    public var body: some View {
      Group {
        if let thread = store.thread(threadId) {
          VStack(spacing: 0) {
            if store.hasContentCache,
              !store.canFetchContent || store.cachedThreadIDs.contains(threadId)
            {
              HStack {
                Image(systemName: "iphone")
                if case .available(let saved) = store.cacheAvailability[.thread(threadId)] {
                  Text("Saved conversation · ") + Text(saved.fetchedAt, style: .relative)
                    + Text(" ago")
                } else {
                  Text("Cached conversation")
                }
                Spacer()
              }.font(.caption).foregroundStyle(.secondary).padding(.horizontal).padding(.bottom, 8)
            }
            if store.canFetchContent, !thread.surfaces.isEmpty {
              Picker("Conversation view", selection: $tab) {
                Text("Chat").tag("chat")
                ForEach(thread.surfaces, id: \.rawValue) { surface in
                  Text(
                    surface == .browser
                      ? "Browser" : surface == .computer ? "Computer" : surface.rawValue
                  )
                  .tag(surface.rawValue)
                }
              }.pickerStyle(.segmented).padding(.horizontal).padding(.bottom, 8)
            }
            if tab == "chat" || !store.canFetchContent {
              MobileConversation(
                store: store, thread: thread, actionsEnabled: canAct, hostName: hostName,
                drafts: drafts, openNote: openNote, openArtifact: { artifact = $0 })
            } else {
              MobileSurfaceView(
                store: store, threadId: threadId, surface: SurfaceKind(rawValue: tab))
            }
          }
        } else if store.failedThreadIds.contains(threadId) {
          ContentUnavailableView {
            Label("Conversation unavailable", systemImage: "wifi.exclamationmark")
          } description: {
            Text("Reconnect to load this conversation. Your local notes are still available.")
          } actions: {
            Button("Try again") { Task { await store.loadThread(threadId, force: true) } }
              .disabled(!store.canFetchContent)
          }
        } else {
          ProgressView("Loading conversation…")
        }
      }
      .navigationTitle(store.threadTitle(threadId) ?? "Conversation")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { threadMenu } }
      .onAppear {
        isVisible = true
        markVisibleRead()
      }
      .onDisappear { isVisible = false }
      .task(id: threadId) {
        await store.loadThread(threadId)
        await store.refreshCacheAvailability(.thread(threadId))
        markVisibleRead()
      }
      .onChange(of: scenePhase) { _, _ in markVisibleRead() }
      .onChange(of: canAct) { _, _ in markVisibleRead() }
      .onChange(of: store.unreadCount(forThread: threadId)) { _, _ in markVisibleRead() }
      .sheet(item: $artifact) { meta in
        NavigationStack { MobileArtifactView(store: store, meta: meta, openNote: openNote) }
      }
      .sheet(
        isPresented: Binding(get: { repeatDraft != nil }, set: { if !$0 { repeatDraft = nil } })
      ) {
        if let repeatDraft {
          MobileNewRoutineView(store: store, initial: repeatDraft, actionsEnabled: canAct) {
            _ in
            self.repeatDraft = nil
          }
        }
      }
      .modifier(MobileAgentError(store: store))
    }

    @ViewBuilder private var threadMenu: some View {
      Menu("Conversation actions", systemImage: "ellipsis.circle") {
        if let record = store.record(forThread: threadId) {
          Button("Show in note", systemImage: "note.text") {
            openNote(record.notePath, record.line)
          }
        } else if let path = store.thread(threadId)?.notePath {
          Button("Show in note", systemImage: "note.text") { openNote(path, nil) }
        }
        if store.hasContentCache {
          let pinned = store.cacheAvailability[.thread(threadId)]?.pinned ?? false
          Button(
            pinned ? "Remove offline pin" : "Keep offline",
            systemImage: pinned ? "pin.slash" : "pin"
          ) {
            Task {
              await store.setContentPinned(.thread(threadId), pinned: !pinned)
              if !pinned, store.canFetchContent {
                await store.loadThread(threadId, force: true)
                await store.flushContentCache()
                await store.refreshCacheAvailability(.thread(threadId))
              }
            }
          }
        }
        Button("Refresh", systemImage: "arrow.clockwise") {
          Task { await store.loadThread(threadId, force: true) }
        }.disabled(!store.canFetchContent)
        if let status = store.threadStatus(threadId), !status.isActive,
          threadId != OrchestratorThread.id
        {
          Button("Retry task", systemImage: "arrow.trianglehead.clockwise") {
            Task { await store.retryThread(threadId) }
          }.disabled(!canAct || store.readOnly != nil)
          Button("Repeat this…", systemImage: "repeat") {
            repeatDraft = RoutineDraft(
              repeating: store.threadTitle(threadId) ?? "", threadId: threadId)
          }.disabled(!canAct || store.readOnly != nil)
        }
        if let artifacts = store.thread(threadId)?.artifacts, !artifacts.isEmpty {
          Section("Artifacts") {
            ForEach(artifacts) { meta in
              Button(meta.title, systemImage: meta.kind.systemImage) { artifact = meta }
            }
          }
        }
      }
    }

    private func markVisibleRead() {
      guard canAct, isVisible, scenePhase == .active, artifact == nil, repeatDraft == nil,
        store.thread(threadId) != nil
      else { return }
      store.markRead(threadId)
    }
  }

#endif
