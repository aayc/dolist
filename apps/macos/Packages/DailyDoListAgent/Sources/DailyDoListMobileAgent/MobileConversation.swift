#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  struct MobileConversation: View {
    let store: AgentStore
    let thread: AgentThread
    let actionsEnabled: Bool
    let hostName: String?
    let drafts: MobileAgentDrafts?
    let openNote: (String, Int?) -> Void
    let openArtifact: (ArtifactMeta) -> Void
    @State private var followsLatest = true
    @State private var showsLatest = true
    @State private var focusedMessage: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private struct Tail: Equatable {
      let count: Int
      let last: ThreadMessage?
    }

    var body: some View {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 16) {
            header
            let included = Set(
              thread.messages.compactMap { message -> String? in
                if case .approval(let approval) = message { return approval.approvalId }
                return nil
              })
            ForEach(
              store.pendingApprovals(forThread: thread.id).filter { !included.contains($0.id) }
            ) {
              MobileApprovalCard(
                store: store, approval: $0, actionsEnabled: actionsEnabled, hostName: hostName)
            }
            ForEach(ChatItem.make(thread.messages, aliases: store.messageAliases)) { item in
              MobileMessageRow(
                store: store, thread: thread, item: item, actionsEnabled: actionsEnabled,
                hostName: hostName, openNote: openNote, openArtifact: openArtifact
              )
              .padding(6)
              .background(
                focusedMessage == item.id ? Color.accentColor.opacity(0.12) : Color.clear,
                in: RoundedRectangle(cornerRadius: 8)
              )
              .id(item.id)
            }
            if !store.cachedContentReadOnly, !store.cachedThreadIDs.contains(thread.id),
              let activity = ChatActivity.current(
                status: thread.status, messages: thread.messages,
                pendingApprovals: store.pendingApprovals(forThread: thread.id),
                isTextActive: thread.messages.contains {
                  if case .text(let text) = $0 { text.streaming == true } else { false }
                })
            {
              TimelineView(.periodic(from: .now, by: 1)) { context in
                HStack {
                  if thread.status == .working { ProgressView().controlSize(.small) }
                  Text(activity.label)
                  if let elapsed = ChatActivity.elapsed(since: activity.since, now: context.date) {
                    Text(elapsed).monospacedDigit()
                  }
                }.font(.caption).foregroundStyle(.secondary)
              }
            }
            Color.clear.frame(height: 1).id("latest")
              .onAppear {
                showsLatest = true
                followsLatest = true
              }
              .onDisappear { showsLatest = false }
          }.padding()
        }
        .simultaneousGesture(DragGesture().onChanged { _ in followsLatest = false })
        .onAppear {
          if !showFocus(proxy) { proxy.scrollTo("latest", anchor: .bottom) }
        }
        .onChange(of: Tail(count: thread.messages.count, last: thread.messages.last)) { _, _ in
          if followsLatest { proxy.scrollTo("latest", anchor: .bottom) }
        }
        .onChange(of: store.orchestratorFocus) { _, _ in _ = showFocus(proxy) }
        .overlay(alignment: .bottom) {
          if !showsLatest {
            Button("Jump to latest", systemImage: "arrow.down") {
              followsLatest = true
              withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                proxy.scrollTo("latest", anchor: .bottom)
              }
            }.buttonStyle(.borderedProminent).padding()
          }
        }
        .safeAreaInset(edge: .bottom) {
          MobileComposer(
            store: store, threadId: thread.id, actionsEnabled: actionsEnabled, drafts: drafts)
        }
      }
    }

    private var header: some View {
      VStack(alignment: .leading, spacing: 8) {
        MobileStatusLabel(status: thread.status)
        if let hostName {
          Label(hostName, systemImage: "desktopcomputer").font(.caption).foregroundStyle(.secondary)
        }
        if let reason = store.readOnly?.reason
          ?? (!actionsEnabled ? "Reconnect to reply or approve actions." : store.unavailableReason)
        {
          MobileAgentNotice(title: "Agent availability", message: reason)
        }
        if thread.messages.isEmpty {
          Text(
            thread.isOrchestrator
              ? "Each wake, decision and follow-up appears here."
              : "The conversation will appear here as the agent works."
          )
          .foregroundStyle(.secondary)
        }
      }
    }

    @discardableResult private func showFocus(_ proxy: ScrollViewProxy) -> Bool {
      guard thread.isOrchestrator, let focus = store.orchestratorFocus,
        thread.messages.contains(where: { $0.id == focus.messageId })
      else { return false }
      followsLatest = false
      let row =
        ChatItem.make(thread.messages, aliases: store.messageAliases).first { item in
          switch item.content {
          case .message(let message): message.id == focus.messageId
          case .tools(let calls): calls.contains { $0.id == focus.messageId }
          }
        }?.id ?? focus.messageId
      focusedMessage = row
      proxy.scrollTo(row, anchor: .center)
      store.orchestratorFocusShown(focus.serial)
      return true
    }
  }

#endif
