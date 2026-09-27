#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  struct MobileMessageRow: View {
    let store: AgentStore
    let thread: AgentThread
    let item: ChatItem
    let actionsEnabled: Bool
    let hostName: String?
    let openNote: (String, Int?) -> Void
    let openArtifact: (ArtifactMeta) -> Void

    var body: some View {
      switch item.content {
      case .tools(let calls):
        if calls.count == 1, let call = calls.first {
          tool(call)
        } else {
          DisclosureGroup("Used \(calls.count) tools") {
            ForEach(calls, id: \.id) { tool($0).padding(.vertical, 6) }
          }.font(.subheadline)
        }
      case .message(let message): messageBody(message)
      }
    }

    @ViewBuilder private func messageBody(_ message: ThreadMessage) -> some View {
      switch message {
      case .text(let message):
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Text(AgentFormat.authorLabel(message.author)).font(.caption.bold())
            Spacer()
            Text(AgentFormat.timestamp(message.createdAt)).font(.caption2).foregroundStyle(
              .secondary)
          }
          MobileMarkdownView(
            source: message.text, streaming: message.streaming == true,
            sources: thread.sources ?? [], openNote: openNote)
          if store.sendingMessageIds.contains(message.id) {
            ProgressView("Sending…").font(.caption)
          }
          if let reason = store.unsentMessages[message.id] {
            Text(reason).font(.caption).foregroundStyle(.red)
            HStack {
              Button("Retry sending") {
                Task { await store.retryMessage(message.id, threadId: thread.id) }
              }
              .disabled(!actionsEnabled || store.readOnly != nil)
              Button("Discard", role: .destructive) {
                store.discardMessage(message.id, threadId: thread.id)
              }
            }.font(.caption)
          }
        }
        .padding(message.role == .user ? 12 : 0)
        .background(
          message.role == .user ? Color.accentColor.opacity(0.08) : Color.clear,
          in: RoundedRectangle(cornerRadius: 12))
      case .approval(let message):
        if let approval = store.approvals[message.approvalId] {
          MobileApprovalCard(
            store: store, approval: approval, actionsEnabled: actionsEnabled, hostName: hostName)
        } else {
          ProgressView("Loading approval…")
        }
      case .artifact(let message):
        if let meta = store.artifactMeta(threadId: thread.id, artifactId: message.artifactId) {
          Button {
            openArtifact(meta)
          } label: {
            HStack {
              Image(systemName: meta.kind.systemImage).font(.title2)
              VStack(alignment: .leading, spacing: 4) {
                Text(meta.title).font(.headline)
                Text("\(meta.kindLabel) · \(AgentFormat.bytes(meta.size))").font(.caption)
                  .foregroundStyle(.secondary)
              }
              Spacer()
              Image(systemName: "chevron.right")
            }.padding()
          }.buttonStyle(.bordered)
        } else {
          ProgressView("Loading artifact…")
        }
      case .status(let message):
        VStack(alignment: .leading, spacing: 4) {
          MobileStatusLabel(status: message.status)
          if let text = message.text { Text(text).font(.subheadline).foregroundStyle(.secondary) }
        }
      case .toolCall(let call): tool(call)
      case .unknown(let kind, _, let raw):
        DisclosureGroup("Message from a newer app version: \(kind)") {
          MobileJSONView(text: raw.prettyJSONString)
        }
      }
    }

    private func tool(_ call: ToolCallMessage) -> some View {
      VStack(alignment: .leading, spacing: 6) {
        DisclosureGroup {
          MobileJSONView(text: call.input.prettyJSONString)
          if let result = call.resultPreview { MobileJSONView(text: result) }
          if let duration = AgentFormat.duration(of: call) {
            Text("Duration: \(duration)").font(.caption).foregroundStyle(.secondary)
          }
        } label: {
          HStack(alignment: .firstTextBaseline) {
            Image(systemName: ToolIcon.systemName(for: call.toolName))
            Text(call.label ?? call.toolName).lineLimit(2)
            Spacer()
            if call.status == .running {
              ProgressView().controlSize(.small)
            } else {
              Image(systemName: call.status.systemImage).foregroundStyle(
                call.status.tone.mobileColor)
            }
          }.font(.subheadline)
        }
        if call.status == .error || call.status == .blocked {
          Text(call.resultPreview ?? call.status.displayLabel).font(.caption).foregroundStyle(
            call.status.tone.mobileColor)
        }
        if let taskId = ThreadMessage.toolCall(call).orchestratorTaskId,
          let link = store.taskLinks(for: [.toolCall(call)])[taskId], let linkedId = link.threadId
        {
          NavigationLink {
            MobileThreadView(
              store: store, threadId: linkedId, actionsEnabled: actionsEnabled,
              hostName: hostName, openNote: openNote)
          } label: {
            Label(link.title, systemImage: "text.bubble").font(.caption)
          }
        }
      }
    }
  }
#endif
