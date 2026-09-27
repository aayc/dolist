#if canImport(UIKit)
  import DailyDoListAgentCore
  import DailyDoListModels
  import SwiftUI

  struct MobileComposer: View {
    let store: AgentStore
    let threadId: String
    let actionsEnabled: Bool
    let drafts: MobileAgentDrafts?
    @State private var text = ""
    @State private var draftLoaded = false
    @State private var draftError: String?
    @State private var stopping = false
    @State private var sending = false
    @FocusState private var focused: Bool

    private var canSend: Bool {
      actionsEnabled && draftLoaded && !sending && store.readOnly == nil && store.isAgentAvailable
        && text.trimmedNonEmpty != nil
    }

    var body: some View {
      VStack(spacing: 8) {
        HStack(alignment: .bottom, spacing: 12) {
          TextField("Reply to the agent…", text: $text, axis: .vertical)
            .lineLimit(1...7).focused($focused).textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("chat.reply").disabled(!draftLoaded)
          if store.threadStatus(threadId)?.isActive == true {
            Button("Stop", systemImage: "stop.fill") {
              stopping = true
              Task {
                await store.cancelThread(threadId)
                stopping = false
              }
            }.labelStyle(.iconOnly).disabled(!actionsEnabled || store.readOnly != nil || stopping)
          }
          Button("Send", systemImage: "arrow.up.circle.fill", action: send)
            .labelStyle(.iconOnly).font(.title2).disabled(!canSend)
            .accessibilityIdentifier("chat.send")
            .keyboardShortcut(.return, modifiers: .command)
        }
        if focused {
          HStack {
            Spacer()
            Button("Hide keyboard", systemImage: "keyboard.chevron.compact.down") {
              focused = false
            }
          }
          .font(.caption)
        }
      }
      .padding().background(.bar)
      .task(id: threadId) {
        draftLoaded = false
        do {
          text = try await drafts?.load(threadId) ?? store.replyDrafts[threadId] ?? ""
          draftLoaded = true
          draftError = nil
        } catch { draftError = "Couldn't load your saved reply. Your draft is preserved." }
      }
      .overlay(alignment: .topLeading) {
        if let draftError { Text(draftError).font(.caption).foregroundStyle(.red).padding() }
      }
      .onChange(of: text) { _, value in
        guard draftLoaded else { return }
        store.replyDrafts[threadId] = value
        drafts?.save(threadId, value)
      }
    }

    private func send() {
      guard canSend else { return }
      let submitted = text
      sending = true
      Task {
        let accepted = await store.postMessage(threadId: threadId, text: submitted)
        sending = false
        if accepted, text == submitted {
          text = ""
          store.replyDrafts[threadId] = ""
          drafts?.save(threadId, "")
        }
      }
    }
  }
#endif
