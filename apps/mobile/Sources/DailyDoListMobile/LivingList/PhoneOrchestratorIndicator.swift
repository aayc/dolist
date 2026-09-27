import DailyDoListDomain
import DailyDoListModels
import SwiftUI

struct PhoneOrchestratorPresentation: Equatable {
  let text: String
  let detail: String?
  let turnID: String?

  init?(activity: OrchestratorActivity?, currentPath: String?, online: Bool) {
    guard online, let activity, activity.phase.isWorking else { return nil }
    if let path = activity.trigger?.notePath, path == currentPath {
      text =
        switch activity.phase {
        case .reading: "Orchestrator: reading this note…"
        case .thinking: "Orchestrator: thinking…"
        default: "Orchestrator: working…"
        }
    } else {
      let summary = activity.trigger?.summary.trimmingCharacters(in: .whitespacesAndNewlines)
      let subject =
        activity.trigger?.notePath.map(VaultPath.stem)
        ?? (summary?.isEmpty == false ? summary : nil) ?? "something"
      text = "Orchestrator: working on \(subject)"
    }
    let summary = activity.trigger?.summary.trimmingCharacters(in: .whitespacesAndNewlines)
    detail = summary?.isEmpty == false ? summary : nil
    turnID = activity.turnId
  }
}

/// Place above the note editor; pressing it opens the exact orchestrator turn when one is known.
/// Offline state never keeps a stale animation claiming that remote work is still live.
struct PhoneOrchestratorIndicator: View {
  let activity: OrchestratorActivity?
  let currentPath: String?
  let online: Bool
  let onOpenTurn: (String?) -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dim = false

  var body: some View {
    if let presentation = PhoneOrchestratorPresentation(
      activity: activity, currentPath: currentPath, online: online)
    {
      Button {
        onOpenTurn(presentation.turnID)
      } label: {
        HStack(spacing: 8) {
          Circle().fill(Color.accentColor).frame(width: 7, height: 7)
            .opacity(reduceMotion ? 1 : dim ? 0.35 : 1)
            .accessibilityHidden(true)
          Text(presentation.text).font(.caption).foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12).frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(presentation.text)
      .accessibilityHint(
        presentation.detail.map { "Woken by \($0). Open the orchestrator conversation." }
          ?? "Open the orchestrator conversation."
      )
      .accessibilityIdentifier("note.orchestrator.activity")
      .task(id: reduceMotion) {
        dim = false
        guard !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { dim = true }
      }
    }
  }
}
