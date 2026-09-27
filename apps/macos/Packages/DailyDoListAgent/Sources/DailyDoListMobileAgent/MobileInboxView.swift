#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  /// Inbox tab, with a pinned orchestrator and routine history separate from task conversations.
  /// The host owns connection/event delivery and supplies current workspace authority.
  public struct MobileInboxView: View {
    let store: AgentStore
    let actionsEnabled: Bool
    let hostName: String?
    let openNote: (String, Int?) -> Void
    let drafts: MobileAgentDrafts?
    @State private var filter = ""

    public init(
      store: AgentStore, actionsEnabled: Bool = false, hostName: String? = nil,
      drafts: MobileAgentDrafts? = nil, openNote: @escaping (String, Int?) -> Void = { _, _ in }
    ) {
      self.store = store
      self.actionsEnabled = actionsEnabled
      self.hostName = hostName
      self.openNote = openNote
      self.drafts = drafts
    }

    private var canAct: Bool { actionsEnabled && !store.cachedContentReadOnly }

    public var body: some View {
      NavigationStack {
        List {
          if !canAct || store.readOnly != nil {
            Section {
              MobileAgentNotice(
                title: "Read-only",
                message: store.readOnly?.reason ?? "Reconnect to send messages or decisions.",
                systemImage: "eye")
            }
          }
          if store.hasContentCache, store.cachedContentReadOnly {
            Section {
              if let saved = store.cachedInboxAt {
                Label {
                  Text("Saved Inbox · ") + Text(saved, style: .relative) + Text(" ago")
                } icon: {
                  Image(systemName: "iphone")
                }
                .font(.caption).foregroundStyle(.secondary)
                Text("Counts and status may have changed on the host.")
                  .font(.caption).foregroundStyle(.secondary)
              } else {
                Text("No Inbox has been downloaded yet. Connect to load it.")
                  .font(.caption).foregroundStyle(.secondary)
              }
            }
          }
          Section {
            NavigationLink {
              thread(OrchestratorThread.id)
            } label: {
              VStack(alignment: .leading, spacing: 5) {
                Label("Orchestrator", systemImage: "sparkles").font(.headline)
                if let status = store.orchestratorSummary?.status {
                  MobileStatusLabel(status: status)
                }
                Text("Every task, every decision").font(.caption).foregroundStyle(.secondary)
              }.padding(.vertical, 4)
            }
            NavigationLink {
              MobileRoutinesView(
                store: store, actionsEnabled: canAct, hostName: hostName, drafts: drafts,
                openNote: openNote)
            } label: {
              Label("Routines", systemImage: "repeat")
            }
          }
          let orphaned = store.pendingApprovals.filter { $0.threadId == nil }
          if !orphaned.isEmpty {
            Section("Approvals") {
              ForEach(orphaned) {
                MobileApprovalCard(
                  store: store, approval: $0, actionsEnabled: canAct, hostName: hostName)
              }
            }
          }
          ForEach(store.inboxSections()) { section in
            let summaries = section.threads.filter {
              filter.isEmpty || $0.title.localizedCaseInsensitiveContains(filter)
                || ($0.notePath?.localizedCaseInsensitiveContains(filter) ?? false)
            }
            if !summaries.isEmpty {
              Section(section.group.title) {
                ForEach(summaries) { summary in
                  NavigationLink {
                    thread(summary.id)
                  } label: {
                    MobileThreadRow(store: store, summary: summary)
                  }
                }
              }
            }
          }
          if store.inboxSections().isEmpty {
            ContentUnavailableView(
              store.cachedContentReadOnly
                ? "No downloaded conversations" : "No task conversations yet", systemImage: "tray",
              description: Text(
                store.cachedContentReadOnly
                  ? "Connect to load task conversations."
                  : "Write in your daily note to start a conversation with the agent."))
          }
        }
        .navigationTitle("Inbox")
        .searchable(text: $filter, prompt: "Filter by task or note")
        .task { await store.hydrateCachedContent() }
        .refreshable { await store.refresh() }
        .modifier(MobileAgentError(store: store))
        .toolbar {
          if let status = store.status {
            ToolbarItem(placement: .topBarTrailing) {
              Button(
                status.enabled ? "Pause agent" : "Resume agent",
                systemImage: status.enabled ? "pause.circle" : "play.circle"
              ) {
                Task { await store.setEnabled(!status.enabled) }
              }
              .disabled(!canAct || store.readOnly != nil)
            }
          }
        }
      }
    }

    private func thread(_ id: String) -> some View {
      MobileThreadView(
        store: store, threadId: id, actionsEnabled: canAct, hostName: hostName,
        drafts: drafts, openNote: openNote)
    }
  }

  struct MobileThreadRow: View {
    let store: AgentStore
    let summary: ThreadSummary
    var body: some View {
      VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline) {
          Text(summary.title).font(.headline).lineLimit(2)
          Spacer(minLength: 4)
          let unread = store.unreadCount(forThread: summary.id)
          if unread > 0 {
            Text("\(unread)").font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 2)
              .background(.tint, in: Capsule()).foregroundStyle(.white)
              .accessibilityLabel("\(unread) unread messages")
          }
        }
        MobileStatusLabel(status: summary.status)
        if let preview = summary.lastMessagePreview, !preview.isEmpty {
          Text(AgentFormat.plainPreview(preview)).font(.subheadline).foregroundStyle(.secondary)
            .lineLimit(2)
        }
        HStack {
          if let path = summary.notePath { Text(path).lineLimit(1).truncationMode(.middle) }
          Spacer()
          Text(AgentFormat.relativeTime(Date(epochMillis: summary.updatedAt)))
        }.font(.caption2).foregroundStyle(.secondary)
      }.padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
  }
#endif
