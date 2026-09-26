import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// What the host does for the orchestrator's Remote switch row.
public struct AgentPlacementActions {
  /// Opens the Settings pane that sets up what's missing (the always-on machine, or sync).
  public var openSetUp: ((OrchestratorLocation.SetUp) -> Void)?

  public init(openSetUp: ((OrchestratorLocation.SetUp) -> Void)? = nil) {
    self.openSetUp = openSetUp
  }

  public static var none: AgentPlacementActions { AgentPlacementActions() }
}

/// Under the agent panel's header: "Orchestrator … Remote" and its switch, one click away,
/// disabled with the reason while the agent is held on this device (and a way to set up what's
/// missing), the handover as it happens, and "Run It on This Device Instead" when the always-on
/// machine can't be reached. On the always-on machine itself it just says so.
struct OrchestratorLocationBar: View {
  let store: AgentStore
  let location: OrchestratorLocation
  let shortcuts: AgentPanelShortcuts
  let actions: AgentPlacementActions
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if location.isHost {
        Label("This is the always-on machine", systemImage: "server.rack")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(AgentTheme.mutedText)
      } else {
        HStack(spacing: 8) {
          Text("Orchestrator")
            .foregroundStyle(AgentTheme.mutedText)
          Spacer(minLength: 0)
          OrchestratorSwitch(store: store, location: location, shortcuts: shortcuts)
            .foregroundStyle(AgentTheme.text)
            .controlSize(.mini)
            .fixedSize()
        }
        .font(.system(size: 12))
      }
      if let line = location.line {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
          LocationLine(line: line)
          if let setUp = location.setUp, let open = actions.openSetUp {
            Button {
              open(setUp)
            } label: {
              Text(setUpTitle)
                .font(.caption.weight(.medium))
                .foregroundStyle(AgentTheme.accent)
            }
            .buttonStyle(ChromeButtonStyle(horizontalPadding: 4, verticalPadding: 1))
            .fixedSize()
            .tooltip(
              setUp == .sync
                ? "Set up sync"
                : location.pairsAgain
                  ? "Pair this device with the always-on machine again"
                  : "Set up the always-on machine")
          }
        }
        .transition(.opacity)
      }
      if location.offersRunHere {
        Button("Run It on This Device Instead") {
          Task { await store.moveOrchestrator(to: .thisDevice) }
        }
        .font(.system(size: 12, weight: .medium))
        .buttonStyle(
          ChromeButtonStyle(horizontalPadding: 8, verticalPadding: 3, showsBorder: true)
        )
        .tooltip(
          "Run the orchestrator on this device instead", keys: shortcuts.runHere.keys,
          command: shortcuts.runHere.id)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .bottom) { AgentHairline() }
    .animation(reduceMotion ? nil : .snappy(duration: 0.2), value: location)
  }

  private var setUpTitle: String {
    if location.heldHere != nil { return "Set Up…" }
    return location.pairsAgain ? "Pair Again…" : "Pair…"
  }
}

/// Over the agent panel while its work is read-only here: why, and that it's the synced copy.
struct ReadOnlyBanner: View {
  let kind: AgentReadOnly.Kind
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: kind == .elsewhere || kind == .idle ? "eye" : "icloud.slash")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(AgentTheme.info)
      Text(text)
        .font(.caption)
        .foregroundStyle(AgentTheme.text)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 7)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AgentTheme.info.opacity(0.10))
    .overlay(alignment: .bottom) { AgentHairline() }
    .accessibilityElement(children: .combine)
  }
}

/// The handover's note, the relay's trouble, or who else runs the agent.
private struct LocationLine: View {
  let line: OrchestratorLocation.Line

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      if line.inProgress {
        ProgressView().controlSize(.mini).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
      } else {
        Circle().fill(line.tone.color).frame(width: 6, height: 6)
      }
      Text(line.text)
        .font(.caption)
        .foregroundStyle(line.tone == .faint ? AgentTheme.mutedText : line.tone.color)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
  }
}
