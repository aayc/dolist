import DailyDoListDomain
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// The words for a turn under way: in the note header while it's about the open note
/// ("Orchestrator: reading this note…"), in the status bar while it's about anything else
/// ("Orchestrator: working on 2026-09-24"), the web app's wording.
struct OrchestratorActivityPresentation: Equatable {
  var activity: OrchestratorActivity

  /// The note header's text, for the open note.
  var headerText: String {
    switch activity.phase {
    case .reading: "Orchestrator: reading this note…"
    case .thinking: "Orchestrator: thinking…"
    default: "Orchestrator: working…"
    }
  }

  /// The status bar's text: the note it works on (its name), or what woke it.
  var statusText: String {
    "Orchestrator: working on \(subject)"
  }

  private var subject: String {
    if let path = activity.trigger?.notePath { return VaultPath.stem(path) }
    return activity.trigger?.summary.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
      ?? "something"
  }

  /// What woke it, and what clicking does.
  var tooltip: String {
    guard let summary = activity.trigger?.summary.nilIfEmpty else {
      return "Open the orchestrator chat"
    }
    return "Woken by \(summary) — open the orchestrator chat"
  }

}

/// A turn under way on the open note, beside its title: a breathing dot (still with Reduce
/// Motion) and what it's doing; clicking opens the orchestrator's chat at the turn.
struct OrchestratorNoteIndicator: View {
  let workspace: Workspace
  let path: String

  var body: some View {
    if let activity = workspace.orchestrator.working(on: path) {
      let presentation = OrchestratorActivityPresentation(activity: activity)
      Button {
        workspace.openOrchestratorTurn?(activity.turnId)
      } label: {
        HStack(spacing: 6) {
          OrchestratorPulse()
          Text(presentation.headerText)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.mutedText)
        }
      }
      .buttonStyle(
        ChromeButtonStyle(cornerRadius: 5, horizontalPadding: 6, verticalPadding: 3)
      )
      .tooltip(presentation.tooltip, command: .orchestratorChat)
      .accessibilityLabel(presentation.headerText)
    }
  }
}

/// A turn under way on another note (or on no note), in the status bar.
struct OrchestratorStatusItem: View {
  let workspace: Workspace

  var body: some View {
    if let activity = workspace.orchestrator.working,
      activity.trigger?.notePath.map({ $0 != workspace.tabs.active }) ?? true
    {
      let presentation = OrchestratorActivityPresentation(activity: activity)
      Button {
        workspace.openOrchestratorTurn?(activity.turnId)
      } label: {
        HStack(spacing: 5) {
          OrchestratorPulse()
          Text(presentation.statusText).foregroundStyle(Theme.mutedText)
        }
      }
      .buttonStyle(ChromeButtonStyle(cornerRadius: 5, horizontalPadding: 6, verticalPadding: 3))
      .tooltip(presentation.tooltip, command: .orchestratorChat)
      .accessibilityLabel(presentation.statusText)
    }
  }
}

/// The accent dot of a turn under way; it breathes like the editor's triaging dot, and stays
/// still with Reduce Motion.
struct OrchestratorPulse: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dim = false

  var body: some View {
    Circle()
      .fill(Theme.accent)
      .frame(width: 6, height: 6)
      .opacity(dim ? 0.35 : 1)
      .onAppear {
        guard !reduceMotion else { return }
        withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { dim = true }
      }
      .onChange(of: reduceMotion) { _, reduce in
        if reduce {
          withAnimation(nil) { dim = false }
        }
      }
      .accessibilityHidden(true)
  }
}
